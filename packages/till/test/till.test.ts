/**
 * The till's scan decision, end to end over real signed vouchers. Each branch
 * is reached for the reason it names, and the one ordinary path — a good
 * voucher for the right amount — is taken.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { p256 } from "@noble/curves/p256";
import type { Enrolment } from "@nelo/accept";
import { emptyCache, type EnrolmentCache } from "@nelo/enrol";
import { enqueue, type Entry } from "@nelo/queue";
import { encode, encodeBase58, signedMessage, toQr, type Voucher } from "@nelo/voucher";
import { describeRisk, scan, seenFor } from "../src/index.ts";

const NOW = 1_789_000_000;
const SK = new Uint8Array(32).fill(7);
const VAULT_BYTES = new Uint8Array(32).fill(1);
const VAULT = encodeBase58(VAULT_BYTES);
const MERCHANT_BYTES = new Uint8Array(32).fill(2);
const MERCHANT = encodeBase58(MERCHANT_BYTES);

function packet(o: Partial<Omit<Voucher, "signature" | "devicePubkey">> = {}): Uint8Array {
  const fields = {
    version: 1,
    vault: VAULT_BYTES,
    seq: 3n,
    amount: 5_000_000n,
    remainingAfter: 45_000_000n,
    merchant: MERCHANT_BYTES,
    expiresAt: BigInt(NOW + 3600),
    salt: new Uint8Array(8),
    ...o,
  };
  return encode({
    ...fields,
    signature: p256.sign(signedMessage(fields), SK, { prehash: true, lowS: true }).toCompactRawBytes(),
    devicePubkey: p256.getPublicKey(SK, true),
  });
}

const enrolment: Enrolment = {
  vault: VAULT,
  devicePubkey: p256.getPublicKey(SK, true),
  mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  balance: 50_000_000n,
  floorLimit: 50_000_000n,
  stake: 0n,
  pendingUnstake: 0n,
  reputationBps: 10_000,
  seqBase: 0n,
  seqBitmap: 0n,
  status: 0,
  syncedAt: NOW - 60,
};

const synced: EnrolmentCache = {
  vaults: new Map([[VAULT, enrolment]]),
  risk: { kBps: 0, stakeReference: 1n, hardCap: 10n ** 12n, stakePrice: 0n, haircutBps: 0 },
  riskSyncedAt: NOW - 60,
  fullSyncAt: NOW - 60,
};

function added(packetBytes: Uint8Array): Entry {
  const r = enqueue(() => undefined, packetBytes, NOW * 1000);
  assert.equal(r.kind, "added");
  return (r as Extract<typeof r, { kind: "added" }>).entry;
}

const run = (o: Partial<Parameters<typeof scan>[0]> = {}) =>
  scan({ text: toQr(packet()), cache: synced, merchant: MERCHANT, charged: 5_000_000n, queued: [], now: NOW, ...o });

test("a good voucher for the charge is taken", () => {
  const r = run();
  assert.equal(r.kind, "take");
  if (r.kind === "take") {
    assert.equal(r.amount, 5_000_000n);
    assert.equal(r.overpaid, false);
    assert.deepEqual(r.risks.map((x) => x.kind), ["sequence-unconfirmed"]);
  }
});

test("paying more than charged is taken and flagged; paying less is not taken", () => {
  const over = run({ text: toQr(packet({ amount: 6_000_000n })) });
  assert.ok(over.kind === "take" && over.overpaid);
  const under = run({ text: toQr(packet({ amount: 4_000_000n })) });
  assert.deepEqual(under, { kind: "short", paid: 4_000_000n, charged: 5_000_000n });
});

test("a code that is not a voucher says so", () => {
  const r = run({ text: "solana:abc" });
  assert.equal(r.kind, "not-a-voucher");
});

test("a till that has never synced says so, rather than refusing the payer", () => {
  assert.deepEqual(run({ cache: emptyCache() }), { kind: "not-synced" });
});

test("a vault the till has never seen is named, not refused as fraud", () => {
  const stranger = new Uint8Array(32).fill(9);
  const r = run({ text: toQr(packet({ vault: stranger })) });
  assert.deepEqual(r, { kind: "unknown-vault", vault: encodeBase58(stranger) });
});

test("a voucher made out to another merchant is refused", () => {
  const r = run({ merchant: encodeBase58(new Uint8Array(32).fill(8)) });
  assert.equal(r.kind, "refused");
  if (r.kind === "refused") assert.match(r.reason, /different merchant/);
});

test("a voucher already in this till's queue is refused on the second showing", () => {
  const p = packet();
  const r = run({ text: toQr(p), queued: [added(p)] });
  assert.equal(r.kind, "refused");
  if (r.kind === "refused") assert.match(r.reason, /already presented/);
});

test("seenFor reads remainingAfter from each queued packet of that vault only", () => {
  const mine = added(packet({ seq: 3n, remainingAfter: 7n }));
  const other = added(packet({ vault: new Uint8Array(32).fill(9), seq: 4n }));
  const seen = seenFor([mine, other], VAULT);
  assert.deepEqual([...seen], [[3n, 7n]]);
});

test("every risk has a sentence a shopkeeper can read", () => {
  for (const risk of [
    { kind: "stale-enrolment", ageSeconds: 7200 },
    { kind: "vault-frozen" },
    { kind: "collateral-may-be-spent", cachedBalance: 1n, amount: 2n },
    { kind: "sequence-unconfirmed", seq: 1n },
    { kind: "remaining-disputed", claimed: 1n, expected: 2n },
  ] as const) {
    assert.ok(describeRisk(risk).length > 10, risk.kind);
  }
});
