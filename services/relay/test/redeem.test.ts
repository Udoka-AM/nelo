/**
 * The relayer submitting vouchers, against a fake RPC that answers from a
 * script and records what it was asked. What matters most here is idempotence:
 * a till that asks twice must get one transaction, not two.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { p256 } from "@noble/curves/p256";
import { ed25519 } from "@noble/curves/ed25519";
import { getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import { decodeBase58, encode, encodeBase58, signedMessage, type Voucher } from "@nelo/voucher";
import { NELO_VAULT_PROGRAM_ID, SECP256R1_PROGRAM_ID } from "@nelo/redeem";
import {
  ATA_RENT_LAMPORTS,
  SIGNATURE_FEE_LAMPORTS,
  emptyLedger,
  feePayerFromSecret,
  memoryLedger,
  redeem,
  type RelayRpc,
} from "../src/index.ts";

const NOW = 1_789_000_000;
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const DEVICE = new Uint8Array(32).fill(7);

const secret = ed25519.utils.randomPrivateKey();
const FEE_PAYER = feePayerFromSecret(Uint8Array.from([...secret, ...ed25519.getPublicKey(secret)]));

function packet(o: Partial<Omit<Voucher, "signature" | "devicePubkey">> = {}): Uint8Array {
  const fields = {
    version: 1,
    vault: new Uint8Array(32).fill(0x11),
    seq: 5n,
    amount: 5_000_000n,
    remainingAfter: 45_000_000n,
    merchant: new Uint8Array(32).fill(0x22),
    expiresAt: BigInt(NOW + 3600),
    salt: new Uint8Array(8),
    ...o,
  };
  return encode({
    ...fields,
    signature: p256.sign(signedMessage(fields), DEVICE, { prehash: true, lowS: true }).toCompactRawBytes(),
    devicePubkey: p256.getPublicKey(DEVICE, true),
  });
}

interface Script {
  height?: number;
  known?: Set<string>;
  tokenExists?: boolean;
  send?: (wire: string) => { ok: true } | { ok: false; err: unknown };
  sendThrows?: boolean;
}

function fakeRpc(script: Script = {}) {
  const sent: string[] = [];
  let blockhashes = 0;
  const rpc: RelayRpc = {
    async latestBlockhash() {
      blockhashes++;
      return { blockhash: encodeBase58(new Uint8Array(32).fill(blockhashes)), lastValidBlockHeight: 1_000 };
    },
    blockHeight: async () => script.height ?? 900,
    accountExists: async () => script.tokenExists ?? true,
    signatureKnown: async (s) => script.known?.has(s) ?? false,
    async send(wire) {
      sent.push(wire);
      if (script.sendThrows) throw new Error("socket hang up");
      return script.send ? script.send(wire) : { ok: true };
    },
  };
  return { rpc, sent, script };
}

const limits = { budgetLamports: 1_000_000_000, maxPerVault: 100, allowedMints: [USDC], sponsorNewAccounts: true };

function setup(script: Script = {}) {
  const ledger = memoryLedger(emptyLedger("2026-09-24"));
  const net = fakeRpc(script);
  const deps = { rpc: net.rpc, feePayer: FEE_PAYER, ledger, config: { mint: USDC, limits }, now: NOW };
  return { ledger, net, deps };
}

// ---- the transaction ----

test("a good voucher is submitted, paid and signed by the relayer, precompile first", async () => {
  const { net, deps } = setup();
  const r = await redeem(packet(), deps);
  assert.equal(r.status, "sent");
  assert.equal(net.sent.length, 1);

  const tx = getTransactionDecoder().decode(new Uint8Array(Buffer.from(net.sent[0]!, "base64")));
  const message = new Uint8Array(tx.messageBytes);
  const m = getCompiledTransactionMessageDecoder().decode(message);
  assert.equal(m.staticAccounts[0], FEE_PAYER.address, "the relayer pays");
  assert.equal(m.header.numSignerAccounts, 1, "and is the only signer: the merchant signs nothing");
  if (!("instructions" in m)) throw new Error("legacy expected");
  assert.equal(m.staticAccounts[m.instructions[0]!.programAddressIndex], SECP256R1_PROGRAM_ID);
  assert.equal(m.staticAccounts[m.instructions[1]!.programAddressIndex], NELO_VAULT_PROGRAM_ID);

  const sig = (tx.signatures as Record<string, Uint8Array>)[FEE_PAYER.address]!;
  assert.ok(ed25519.verify(sig, message, decodeBase58(FEE_PAYER.address)));
  if (r.status === "sent") assert.equal(r.signature, encodeBase58(sig));
});

test("the submission is written to the ledger before the transaction is sent", async () => {
  const { ledger, deps } = setup();
  const rpc = { ...deps.rpc };
  const inner = rpc.send;
  rpc.send = async (wire) => {
    assert.equal(Object.keys(ledger.state().submissions).length, 1, "on disk before it leaves");
    return inner(wire);
  };
  assert.equal((await redeem(packet(), { ...deps, rpc })).status, "sent");
});

// ---- asked twice ----

test("asked again while the first can still land: the same signature, nothing sent", async () => {
  const { net, deps } = setup({ height: 900 });
  const first = await redeem(packet(), deps);
  const second = await redeem(packet(), deps);
  assert.deepEqual(second, first);
  assert.equal(net.sent.length, 1);
});

test("asked again after the first landed: the same signature, nothing sent", async () => {
  const { net, deps } = setup({ height: 5_000, known: new Set() });
  const first = await redeem(packet(), deps);
  if (first.status === "sent") net.script.known!.add(first.signature);
  const second = await redeem(packet(), deps);
  assert.deepEqual(second, first);
  assert.equal(net.sent.length, 1);
});

test("asked again once the first provably cannot land: a new transaction", async () => {
  const { net, deps, ledger } = setup({ height: 900 });
  const first = await redeem(packet(), deps);
  net.script.height = 1_001; // past the first one's last valid block height, and not found
  const second = await redeem(packet(), deps);
  assert.equal(second.status, "sent");
  assert.notDeepEqual(second, first);
  assert.equal(net.sent.length, 2);
  assert.equal(ledger.state().spentLamports, SIGNATURE_FEE_LAMPORTS, "the dead one's cost was given back");
});

test("a send that dies in transit is answered as sent, and looked up rather than rebuilt next time", async () => {
  const { net, deps } = setup({ sendThrows: true, height: 900 });
  const first = await redeem(packet(), deps);
  assert.equal(first.status, "sent");
  net.script.sendThrows = false;
  const second = await redeem(packet(), deps);
  assert.deepEqual(second, first);
  assert.equal(net.sent.length, 1, "the retry did not build a second transaction");
});

test("a different voucher at a sequence already submitted is declined for good", async () => {
  const { net, deps } = setup();
  const first = packet({ amount: 5_000_000n });
  await redeem(first, deps);
  const r = await redeem(packet({ amount: 9_000_000n }), deps);
  assert.deepEqual(r, {
    status: "declined",
    reason: "a different voucher at this sequence was already submitted",
    retryable: false,
    // The other half of the proof, handed back so the pair can be reported.
    conflictWith: Buffer.from(first).toString("base64"),
  });
  assert.equal(net.sent.length, 1);
});

// ---- refusals ----

test("a simulation refusal is passed back as the chain's error, and costs nothing", async () => {
  const err = { InstructionError: [1, { Custom: 6010 }] };
  const { ledger, deps } = setup({ send: () => ({ ok: false, err }) });
  const r = await redeem(packet(), deps);
  assert.deepEqual(r, { status: "rejected", err });
  assert.deepEqual(ledger.state().submissions, {});
  assert.equal(ledger.state().spentLamports, 0);
});

test("the policy's refusals are declined, and only a spent budget is worth retrying", async () => {
  const expired = await redeem(packet({ expiresAt: BigInt(NOW - 1) }), setup().deps);
  assert.deepEqual(expired, { status: "declined", reason: "voucher has expired", retryable: false });

  const broke = setup();
  const r = await redeem(packet(), { ...broke.deps, config: { mint: USDC, limits: { ...limits, budgetLamports: 1 } } });
  assert.equal(r.status, "declined");
  if (r.status === "declined") assert.equal(r.retryable, true);
});

test("a merchant's first token account is funded once, and never again", async () => {
  const { net, deps, ledger } = setup({ tokenExists: false });
  const first = await redeem(packet({ seq: 1n }), deps);
  assert.equal(first.status, "sent");
  assert.equal(ledger.state().spentLamports, SIGNATURE_FEE_LAMPORTS + ATA_RENT_LAMPORTS);

  // The account is gone again: the merchant closed it. Paying rent a second
  // time is how a sponsor is drained.
  const again = await redeem(packet({ seq: 2n }), deps);
  assert.deepEqual(again, {
    status: "declined",
    reason: "this merchant's token account was already funded once",
    retryable: false,
  });

  net.script.tokenExists = true;
  assert.equal((await redeem(packet({ seq: 3n }), deps)).status, "sent", "with the account there, fees only");
});

test("bytes that are not a voucher are declined, not thrown", async () => {
  const r = await redeem(new Uint8Array(202), setup().deps);
  assert.equal(r.status, "declined");
});
