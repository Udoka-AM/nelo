/**
 * The relayer paying the fee on a merchant's cash-out transfer, against a fake
 * RPC. What matters: it signs only what it built, once per order, and what it
 * spends is bounded.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import { getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import { encodeBase58, decodeBase58 } from "@nelo/voucher";
import { ASSOCIATED_TOKEN_PROGRAM_ID, buildCashout, withSignature } from "@nelo/redeem";
import {
  emptyLedger,
  feePayerFromSecret,
  memoryLedger,
  prepareCashout,
  submitCashout,
  SIGNATURE_FEE_LAMPORTS,
  ATA_RENT_LAMPORTS,
  type RelayRpc,
} from "../src/index.ts";

const NOW = 1_789_000_000;
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const relayerSecret = ed25519.utils.randomPrivateKey();
const FEE_PAYER = feePayerFromSecret(Uint8Array.from([...relayerSecret, ...ed25519.getPublicKey(relayerSecret)]));
const OWNER_KEY = ed25519.utils.randomPrivateKey();
const OWNER = encodeBase58(ed25519.getPublicKey(OWNER_KEY));
const DEPOSIT = encodeBase58(new Uint8Array(32).fill(0x55));

function setup(o: { height?: number; depositExists?: boolean; sponsor?: boolean; perDay?: number; budget?: number } = {}) {
  const sent: string[] = [];
  let blockhashes = 0;
  const script = { height: o.height ?? 900, depositExists: o.depositExists ?? true, send: null as null | (() => { ok: false; err: unknown }) };
  const ledger = memoryLedger(emptyLedger("2026-09-25"));
  const rpc: RelayRpc = {
    async latestBlockhash() {
      blockhashes++;
      return { blockhash: encodeBase58(new Uint8Array(32).fill(blockhashes)), lastValidBlockHeight: 1_000 };
    },
    blockHeight: async () => script.height,
    accountExists: async () => script.depositExists,
    signatureKnown: async () => false,
    async send(wire) {
      sent.push(wire);
      const order = Object.values(ledger.state().transfers ?? {})[0];
      assert.ok(order?.signature, "the signature is on disk before the transfer is sent");
      return script.send ? script.send() : { ok: true };
    },
  };
  const deps = () => ({
    rpc,
    feePayer: FEE_PAYER,
    ledger,
    mint: USDC,
    decimals: 6,
    limits: { perOwnerPerDay: o.perDay ?? 5, sponsorDepositAccounts: o.sponsor ?? false, budgetLamports: o.budget ?? 1_000_000_000 },
    now: NOW,
  });
  return { ledger, rpc, sent, script, deps };
}

const order = (id = "ord_1", amount = 25_000_000n) => ({ order: id, owner: OWNER, deposit: DEPOSIT, amount });

function signAsOwner(wireBase64: string): Uint8Array {
  const wire = new Uint8Array(Buffer.from(wireBase64, "base64"));
  const message = new Uint8Array(getTransactionDecoder().decode(wire).messageBytes);
  return withSignature(wire, OWNER, ed25519.sign(message, OWNER_KEY));
}

test("a cash-out is built for the merchant to sign, with the relayer paying", async () => {
  const s = setup();
  const p = await prepareCashout(order(), s.deps());
  assert.equal(p.status, "prepared");
  if (p.status !== "prepared") return;
  const tx = getTransactionDecoder().decode(new Uint8Array(Buffer.from(p.wire, "base64")));
  const m = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  assert.equal(m.staticAccounts[0], FEE_PAYER.address);
  assert.equal(m.header.numSignerAccounts, 2);
  assert.equal(p.createsAccount, false);
});

test("signed by the merchant, it is co-signed by the relayer and sent, once", async () => {
  const s = setup();
  const p = await prepareCashout(order(), s.deps());
  if (p.status !== "prepared") throw new Error(p.status);
  const r = await submitCashout("ord_1", signAsOwner(p.wire), s.deps());
  assert.equal(r.status, "sent");
  assert.equal(s.sent.length, 1);
  const tx = getTransactionDecoder().decode(new Uint8Array(Buffer.from(s.sent[0]!, "base64")));
  const sigs = tx.signatures as Record<string, Uint8Array>;
  const message = new Uint8Array(tx.messageBytes);
  assert.ok(ed25519.verify(sigs[FEE_PAYER.address]!, message, decodeBase58(FEE_PAYER.address)));
  assert.ok(ed25519.verify(sigs[OWNER]!, message, decodeBase58(OWNER)));
  if (r.status === "sent") assert.equal(r.signature, encodeBase58(sigs[FEE_PAYER.address]!));

  // Asked again, in either step: the same answer, nothing sent.
  assert.deepEqual(await submitCashout("ord_1", signAsOwner(p.wire), s.deps()), r);
  assert.deepEqual(await prepareCashout(order(), s.deps()), r);
  assert.equal(s.sent.length, 1);
  assert.equal(s.ledger.state().spentLamports, 2 * SIGNATURE_FEE_LAMPORTS);
});

test("the relayer signs only the message it built, with the merchant's valid signature on it", async () => {
  const s = setup();
  const p = await prepareCashout(order(), s.deps());
  if (p.status !== "prepared") throw new Error(p.status);
  // Unsigned.
  assert.equal((await submitCashout("ord_1", new Uint8Array(Buffer.from(p.wire, "base64")), s.deps())).status, "declined");
  // A different transfer the merchant signed: to themselves, for the same order.
  const other = buildCashout(
    { owner: OWNER, deposit: encodeBase58(new Uint8Array(32).fill(0x66)), mint: USDC, amount: 25_000_000n, decimals: 6, feePayer: FEE_PAYER.address, createDepositAccount: false },
    { blockhash: encodeBase58(new Uint8Array(32).fill(1)), lastValidBlockHeight: 1_000n },
  );
  const otherSigned = withSignature(other.wire, OWNER, ed25519.sign(other.message, OWNER_KEY));
  const r = await submitCashout("ord_1", otherSigned, s.deps());
  assert.equal(r.status, "declined");
  assert.equal(s.sent.length, 0);
  // An order never prepared.
  assert.equal((await submitCashout("ord_x", signAsOwner(p.wire), s.deps())).status, "declined");
});

test("prepared again while live: the same transaction; once too old and unsent, a new one", async () => {
  const s = setup();
  const a = await prepareCashout(order(), s.deps());
  const b = await prepareCashout(order(), s.deps());
  assert.deepEqual(b, a);
  s.script.height = 1_001;
  const c = await prepareCashout(order(), s.deps());
  assert.equal(c.status, "prepared");
  assert.notDeepEqual(c, a);
  // And a too-old one cannot be submitted.
  if (a.status === "prepared") {
    const late = setup({ height: 1_001 });
    const p = await prepareCashout(order(), late.deps());
    if (p.status === "prepared") {
      late.script.height = 2_000;
      const r = await submitCashout("ord_1", signAsOwner(p.wire), late.deps());
      assert.equal(r.status, "declined");
    }
  }
});

test("one order, one cash-out: a different amount or address for the same order is refused", async () => {
  const s = setup();
  await prepareCashout(order(), s.deps());
  assert.equal((await prepareCashout(order("ord_1", 1n), s.deps())).status, "declined");
  assert.equal((await prepareCashout({ ...order(), deposit: OWNER }, s.deps())).status, "declined");
});

test("a deposit address with no token account is opened only when that is sponsored, and costs rent", async () => {
  const off = setup({ depositExists: false });
  const refused = await prepareCashout(order(), off.deps());
  assert.equal(refused.status, "declined");

  const on = setup({ depositExists: false, sponsor: true });
  const p = await prepareCashout(order(), on.deps());
  assert.equal(p.status, "prepared");
  if (p.status !== "prepared") return;
  assert.equal(p.createsAccount, true);
  const tx = getTransactionDecoder().decode(new Uint8Array(Buffer.from(p.wire, "base64")));
  const m = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (!("instructions" in m)) throw new Error("legacy expected");
  assert.equal(m.staticAccounts[m.instructions[0]!.programAddressIndex], ASSOCIATED_TOKEN_PROGRAM_ID);
  await submitCashout("ord_1", signAsOwner(p.wire), on.deps());
  assert.equal(on.ledger.state().spentLamports, 2 * SIGNATURE_FEE_LAMPORTS + ATA_RENT_LAMPORTS);
});

test("a merchant's cash-outs per day are capped, and so is the budget", async () => {
  const s = setup({ perDay: 1 });
  const p = await prepareCashout(order("ord_1"), s.deps());
  if (p.status !== "prepared") throw new Error(p.status);
  await submitCashout("ord_1", signAsOwner(p.wire), s.deps());
  const second = await prepareCashout(order("ord_2"), s.deps());
  assert.deepEqual(second, { status: "declined", reason: "this merchant has reached today's cash-out limit", retryable: true });

  const broke = setup({ budget: 1 });
  assert.equal((await prepareCashout(order(), broke.deps())).status, "declined");
});

test("a transfer the chain refuses in simulation costs nothing, and can be prepared again", async () => {
  const s = setup();
  s.script.send = () => ({ ok: false, err: { InstructionError: [0, { Custom: 1 }] } });
  const p = await prepareCashout(order(), s.deps());
  if (p.status !== "prepared") throw new Error(p.status);
  const r = await submitCashout("ord_1", signAsOwner(p.wire), s.deps());
  assert.equal(r.status, "rejected");
  assert.equal(s.ledger.state().spentLamports, 0);
  assert.equal(s.ledger.state().perOwner?.[OWNER], 0);
  s.script.send = null;
  const again = await prepareCashout(order(), s.deps());
  assert.equal(again.status, "prepared");
  assert.notDeepEqual(again, p, "a fresh transaction, not the refused one");
});

test("nonsense is declined before any RPC call", async () => {
  const s = setup();
  assert.equal((await prepareCashout({ ...order(), amount: 0n }, s.deps())).status, "declined");
  assert.equal((await prepareCashout({ ...order(), order: "../../etc" }, s.deps())).status, "declined");
  assert.equal((await prepareCashout({ ...order(), owner: FEE_PAYER.address }, s.deps())).status, "declined");
});
