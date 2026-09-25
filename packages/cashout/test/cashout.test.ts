/**
 * The phone's side of a cash-out, against fakes of the settlement service and
 * the relayer that keep state the way the real ones do. What matters: however
 * often it is interrupted and run again, the merchant signs one transfer and
 * the USDC moves once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import { getTransactionDecoder } from "@solana/kit";
import { buildCashout } from "@nelo/redeem";
import { decodeBase64, encodeBase58, encodeBase64 } from "@nelo/voucher";
import { cashOut, messageSigner, relayService, ServiceError, settleService, type CashoutRecord } from "../src/index.ts";

const OWNER_KEY = ed25519.utils.randomPrivateKey();
const OWNER = encodeBase58(ed25519.getPublicKey(OWNER_KEY));
const RELAYER = encodeBase58(new Uint8Array(32).fill(0x33));
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const INPUT = { id: "co_000001", merchant: OWNER, destination: "bank:NG:058:0123456789", amount: 25_000_000n };

type Json = Record<string, unknown>;

function world(o: { orderState?: CashoutRecord["state"]; openStatus?: number; openError?: Json; declined?: { reason: string; retryable: boolean } } = {}) {
  const log: string[] = [];
  const failNext = new Set<string>();
  let record: CashoutRecord | null = null;
  let transfer: { wire: string; signature: string | null } | null = null;
  let signs = 0;
  let sends = 0;

  const f = async (url: string, init?: { method?: string; body?: string }) => {
    const [base, path] = [url.startsWith("https://settle") ? "settle" : "relay", url.replace(/^https:\/\/[a-z]+/, "")];
    const step = `${base} ${init?.method ?? "GET"} ${path}`;
    log.push(step);
    if ([...failNext].some((k) => step.includes(k))) {
      failNext.clear();
      throw new Error("connection lost");
    }
    const body = init?.body ? (JSON.parse(init.body) as Json) : {};
    const reply = (b: unknown, status = 200) => ({ ok: status < 300, status, json: async () => b });

    if (path === "/v1/cashouts") {
      if (o.openStatus) return reply(o.openError ?? { error: "no" }, o.openStatus);
      record ??= {
        id: String(body.id),
        state: o.orderState ?? "awaiting-funds",
        reference: "ord_1",
        deposit: encodeBase58(new Uint8Array(32).fill(0x55)),
        fundMinor: String(body.amount),
        localMinor: "3812500",
        transferSignature: null,
        detail: o.orderState === "failed" ? "account name mismatch" : "send the USDC",
      };
      return reply(record);
    }
    if (path === "/v1/cashout/prepare") {
      if (o.declined) return reply({ status: "declined", ...o.declined });
      if (transfer?.signature) return reply({ status: "sent", signature: transfer.signature });
      if (!transfer) {
        const u = buildCashout(
          { owner: OWNER, deposit: String(body.deposit), mint: USDC, amount: BigInt(String(body.amount)), decimals: 6, feePayer: RELAYER, createDepositAccount: false },
          { blockhash: encodeBase58(new Uint8Array(32).fill(7)), lastValidBlockHeight: 99n },
        );
        transfer = { wire: encodeBase64(u.wire), signature: null };
      }
      return reply({ status: "prepared", wire: transfer.wire });
    }
    if (path === "/v1/cashout/submit") {
      const tx = getTransactionDecoder().decode(decodeBase64(String(body.wire)));
      const sig = (tx.signatures as Record<string, Uint8Array | null>)[OWNER];
      assert.ok(sig && ed25519.verify(sig, new Uint8Array(tx.messageBytes), ed25519.getPublicKey(OWNER_KEY)), "the merchant signed it");
      if (!transfer!.signature) {
        sends++;
        transfer!.signature = "5".repeat(87);
      }
      return reply({ status: "sent", signature: transfer!.signature });
    }
    if (path.endsWith("/funded")) {
      record = { ...record!, state: "funded", transferSignature: String(body.signature) };
      return reply(record);
    }
    return reply({ error: "not found" }, 404);
  };

  const sign = async (wire: Uint8Array) => {
    signs++;
    return messageSigner(OWNER, async (m) => encodeBase64(ed25519.sign(decodeBase64(m), OWNER_KEY)))(wire);
  };
  const deps = {
    settle: settleService({ url: "https://settle", token: "t", fetch: f }),
    relay: relayService({ url: "https://relay", token: "t", fetch: f }),
    sign,
  };
  return { deps, log, failNext, counts: () => ({ signs, sends }), record: () => record };
}

test("a cash-out runs through: order, transfer signed once, sent once, reported", async () => {
  const w = world();
  const r = await cashOut(INPUT, w.deps);
  assert.equal(r.kind, "sent");
  if (r.kind === "sent") assert.equal(r.cashout.state, "funded");
  assert.deepEqual(w.counts(), { signs: 1, sends: 1 });
});

test("interrupted at any step and run again with the same id, the USDC moves once", async () => {
  for (const at of ["/v1/cashouts", "/v1/cashout/prepare", "/v1/cashout/submit", "/funded"]) {
    const w = world();
    w.failNext.add(at);
    await assert.rejects(cashOut(INPUT, w.deps), /connection lost/, at);
    const r = await cashOut(INPUT, w.deps);
    assert.equal(r.kind, "sent", at);
    assert.equal(w.counts().sends, 1, `sent once, interrupted at ${at}`);
    assert.equal(w.record()!.state, "funded");
  }
});

test("a cash-out already funded is not touched again", async () => {
  const w = world();
  await cashOut(INPUT, w.deps);
  w.log.length = 0;
  const r = await cashOut(INPUT, w.deps);
  assert.equal(r.kind, "done");
  assert.deepEqual(w.log, ["settle POST /v1/cashouts"], "no relayer call at all");
});

test("refusals are outcomes, with the reason; only a spent limit says wait", async () => {
  assert.deepEqual(
    (await cashOut(INPUT, world({ orderState: "failed" }).deps)).kind,
    "refused",
  );
  assert.equal((await cashOut(INPUT, world({ openStatus: 422, openError: { error: "below the smallest cash-out" } }).deps)).kind, "refused");
  assert.equal((await cashOut(INPUT, world({ openStatus: 429, openError: { error: "that is today's limit" } }).deps)).kind, "wait");
  assert.equal((await cashOut(INPUT, world({ declined: { reason: "budget", retryable: true } }).deps)).kind, "wait");
  const off = await cashOut(INPUT, world({ declined: { reason: "no deposit account", retryable: false } }).deps);
  assert.deepEqual(off.kind === "refused" && off.reason, "no deposit account");
});

test("a settlement service that needs its operator is an error to surface, not a refusal", async () => {
  const w = world({ openStatus: 503, openError: { error: "log in", login: true } });
  await assert.rejects(cashOut(INPUT, w.deps), (e: unknown) => e instanceof ServiceError && e.login);
});

test("a message-signing wallet's signature is used only if it verifies over the transfer", async () => {
  const u = buildCashout(
    { owner: OWNER, deposit: RELAYER, mint: USDC, amount: 1_000_000n, decimals: 6, feePayer: encodeBase58(new Uint8Array(32).fill(9)), createDepositAccount: false },
    { blockhash: encodeBase58(new Uint8Array(32).fill(7)), lastValidBlockHeight: 1n },
  );
  const base64 = messageSigner(OWNER, async (m) => encodeBase64(ed25519.sign(decodeBase64(m), OWNER_KEY)));
  const base58 = messageSigner(OWNER, async (m) => encodeBase58(ed25519.sign(decodeBase64(m), OWNER_KEY)));
  for (const signer of [base64, base58]) {
    const signed = await signer(u.wire);
    const sig = (getTransactionDecoder().decode(signed).signatures as Record<string, Uint8Array>)[OWNER]!;
    assert.ok(ed25519.verify(sig, u.message, ed25519.getPublicKey(OWNER_KEY)));
  }
  // Signed something else (say, the text of the base64 rather than its bytes).
  const wrongBytes = messageSigner(OWNER, async (m) => encodeBase64(ed25519.sign(new TextEncoder().encode(m), OWNER_KEY)));
  await assert.rejects(wrongBytes(u.wire), /does not verify/);
  const someoneElse = ed25519.utils.randomPrivateKey();
  await assert.rejects(messageSigner(OWNER, async (m) => encodeBase64(ed25519.sign(decodeBase64(m), someoneElse)))(u.wire));
  await assert.rejects(messageSigner(OWNER, async () => "not a signature")(u.wire));
});
