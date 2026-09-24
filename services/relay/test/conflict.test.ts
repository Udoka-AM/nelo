/**
 * Double spends: reported once, never paid for twice, and followed by a slash.
 * The vouchers are the `conflict` vectors, which the program's own test
 * generates, and the vault and risk config are the enrol vectors' real
 * account bytes, so everything decoded here is what the chain would hold.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519";
import { getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import { NELO_VAULT_PROGRAM_ID, SECP256R1_PROGRAM_ID, associatedTokenAddress, riskConfigAddress, TOKEN_PROGRAM_ID } from "@nelo/redeem";
import { encodeBase58 } from "@nelo/voucher";
import {
  buildRelay,
  emptyLedger,
  feePayerFromSecret,
  memoryLedger,
  reportConflict,
  sweep,
  SIGNATURE_FEE_LAMPORTS,
  type ConflictRpc,
} from "../src/index.ts";

const R = JSON.parse(readFileSync(new URL("../../../packages/redeem/vectors/redeem-v1.json", import.meta.url), "utf8"));
const E = JSON.parse(readFileSync(new URL("../../../packages/enrol/vectors/accounts-v1.json", import.meta.url), "utf8"));
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const A = unhex(R.conflict.input.packetAHex);
const B = unhex(R.conflict.input.packetBHex);
const VAULT = R.conflict.reportConflict.accounts[1].pubkey as string;
const NOW = 1_789_000_000;
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

const secret = ed25519.utils.randomPrivateKey();
const FEE_PAYER = feePayerFromSecret(Uint8Array.from([...secret, ...ed25519.getPublicKey(secret)]));

/** A real vault account's bytes, with its status byte set. */
function vaultData(status: number): Uint8Array {
  const data = unhex(E.vaults[0].dataHex);
  data[211] = status; // after every field up to unstake_unlock_at
  return data;
}
const RISK = unhex(E.riskConfig.dataHex);
const STAKE_MINT = E.riskConfig.fields.stakeMint as string;
function tokenAccount(amount: bigint): Uint8Array {
  const data = new Uint8Array(165);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  return data;
}

function world(o: { status?: number; stake?: bigint; send?: () => { ok: true } | { ok: false; err: unknown } } = {}) {
  const sent: string[] = [];
  const state = { status: o.status ?? 0, stake: o.stake ?? 100n, height: 900, known: new Set<string>() };
  const rpc: ConflictRpc = {
    latestBlockhash: async () => ({ blockhash: encodeBase58(new Uint8Array(32).fill(sent.length + 1)), lastValidBlockHeight: 1_000 }),
    blockHeight: async () => state.height,
    accountExists: async () => true,
    signatureKnown: async (s) => state.known.has(s),
    async accountData(address) {
      if (address === VAULT) return vaultData(state.status);
      if (address === riskConfigAddress()) return RISK;
      if (address === associatedTokenAddress(VAULT, STAKE_MINT, TOKEN_PROGRAM_ID)) return tokenAccount(state.stake);
      return null;
    },
    async send(wire) {
      sent.push(wire);
      return o.send ? o.send() : { ok: true };
    },
  };
  const ledger = memoryLedger(emptyLedger("2026-09-24"));
  const limits = { budgetLamports: 1e9, maxPerVault: 10, allowedMints: [USDC], sponsorNewAccounts: true };
  const deps = { rpc, feePayer: FEE_PAYER, ledger, limits, now: NOW };
  return { rpc, sent, state, ledger, deps, limits };
}

function programsOf(wire: string): string[] {
  const tx = getTransactionDecoder().decode(new Uint8Array(Buffer.from(wire, "base64")));
  const m = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (!("instructions" in m)) throw new Error("legacy expected");
  return m.instructions.map((i) => m.staticAccounts[i.programAddressIndex]!);
}

test("a double spend is reported: precompile, precompile, report_conflict, paid by the relayer", async () => {
  const w = world();
  const r = await reportConflict(A, B, w.deps);
  assert.equal(r.status, "reported");
  assert.equal(w.sent.length, 1);
  assert.deepEqual(programsOf(w.sent[0]!), [SECP256R1_PROGRAM_ID, SECP256R1_PROGRAM_ID, NELO_VAULT_PROGRAM_ID]);
  const report = w.ledger.state().conflicts![`${VAULT}:9`]!;
  assert.ok(report.a && report.b, "the proof is kept");
  assert.equal(w.ledger.state().spentLamports, SIGNATURE_FEE_LAMPORTS);
});

test("reported once: asked again while live, the same answer and nothing sent", async () => {
  const w = world();
  const first = await reportConflict(A, B, w.deps);
  const again = await reportConflict(B, A, w.deps);
  assert.deepEqual(again, first);
  assert.equal(w.sent.length, 1);
});

test("a vault someone already froze is not paid for again, but the proof is kept", async () => {
  const w = world({ status: 1 });
  assert.deepEqual(await reportConflict(A, B, w.deps), { status: "already-frozen" });
  assert.equal(w.sent.length, 0);
  assert.ok(w.ledger.state().conflicts![`${VAULT}:9`], "kept, so the sweep can still slash");
});

test("anything that is not proof is declined for free", async () => {
  const w = world();
  assert.equal((await reportConflict(A, A, w.deps)).status, "declined");
  const forged = new Uint8Array(B);
  forged[45] ^= 1; // the amount, under the old signature
  assert.equal((await reportConflict(A, forged, w.deps)).status, "declined");
  assert.equal(w.sent.length, 0);
});

test("a report the chain refuses gives the fee back and keeps the proof", async () => {
  const err = { InstructionError: [2, { Custom: 6015 }] };
  const w = world({ send: () => ({ ok: false, err }) });
  assert.deepEqual(await reportConflict(A, B, w.deps), { status: "rejected", err });
  assert.equal(w.ledger.state().spentLamports, 0);
  assert.equal(w.ledger.state().conflicts![`${VAULT}:9`]!.signature, null);
});

test("the sweep slashes a frozen, reported vault once, and leaves an unfrozen one alone", async () => {
  const w = world();
  await reportConflict(A, B, w.deps);
  const early = await sweep(w.deps);
  assert.deepEqual(early.slashed, []);
  assert.equal(early.skipped[0]!.reason, "not frozen yet");

  w.state.status = 1; // the report landed
  const swept = await sweep(w.deps);
  assert.equal(swept.slashed.length, 1);
  assert.deepEqual(programsOf(w.sent.at(-1)!), [NELO_VAULT_PROGRAM_ID]);

  const sentBefore = w.sent.length;
  assert.deepEqual((await sweep(w.deps)).slashed, [], "swept once");
  assert.equal(w.sent.length, sentBefore);
});

test("a frozen vault with no stake is marked done without a transaction", async () => {
  const w = world({ status: 1, stake: 0n });
  await reportConflict(A, B, w.deps);
  const r = await sweep(w.deps);
  assert.deepEqual(r.slashed, []);
  assert.equal(w.sent.length, 0);
  assert.equal(w.ledger.state().conflicts![`${VAULT}:9`]!.slashSignature, "none");
});

test("asked to redeem a second, different voucher at a submitted sequence, the relayer reports the pair itself", async () => {
  const w = world();
  const relay = buildRelay({
    now: () => NOW,
    deps: { rpc: w.rpc, feePayer: FEE_PAYER, ledger: w.ledger, config: { mint: USDC, limits: w.limits } },
  });
  // Both vouchers name merchants and carry an expiry the policy judges; give
  // them one that has not passed.
  const post = (packet: Uint8Array) =>
    relay.app.inject({ method: "POST", url: "/v1/redeem", payload: { packet: Buffer.from(packet).toString("base64") } });

  const first = (await post(A)).json();
  if (first.status !== "sent") {
    // The vectors' vouchers expire at 1_789_000_000 = NOW, which the policy
    // still accepts; anything else is a harness problem, said plainly.
    assert.fail(`first redemption was not sent: ${JSON.stringify(first)}`);
  }
  const second = (await post(B)).json();
  assert.equal(second.status, "declined");
  assert.equal(second.conflict, true);
  assert.equal(second.reported, "reported");
  assert.deepEqual(programsOf(w.sent.at(-1)!), [SECP256R1_PROGRAM_ID, SECP256R1_PROGRAM_ID, NELO_VAULT_PROGRAM_ID]);
});
