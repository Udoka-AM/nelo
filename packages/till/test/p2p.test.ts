/**
 * Two customers settle a bill between them, with no merchant: the week-3
 * done-when, run through the same packages the payer app uses on both phones.
 *
 *   B shows a receive code      → A reads it (@nelo/issue)
 *   A's key signs a voucher     → shown as a QR
 *   B scans it                  → takes it, and keeps it (@nelo/till)
 *   anyone else scanning it     → refused: it pays B, not them
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { p256 } from "@noble/curves/p256";
import { enqueue, type Entry } from "@nelo/queue";
import { initialState, pay, readMerchantCode, type IssuerState, type IssuerStore } from "@nelo/issue";
import { encodeBase58, toQr } from "@nelo/voucher";
import type { EnrolmentCache } from "@nelo/enrol";
import { receiveCode, scan, voucherDb, type SqlDb } from "../src/index.ts";

const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const NOW = 1_789_000_000;
const B = encodeBase58(new Uint8Array(32).fill(0x33));
const C = encodeBase58(new Uint8Array(32).fill(0x44));
const A_VAULT = encodeBase58(new Uint8Array(32).fill(0x11));
const A_KEY = p256.utils.randomPrivateKey();
const A_DEVICE = p256.getPublicKey(A_KEY, true);

const chain = { balance: 100_000_000n, seqBase: 0n, seqBitmap: 0n, unlockAt: 0n, status: 0, limit: 50_000_000n, syncedAt: NOW - 60 };
const cache: EnrolmentCache = {
  vaults: new Map([
    [A_VAULT, { vault: A_VAULT, devicePubkey: A_DEVICE, mint: USDC, balance: chain.balance, floorLimit: 50_000_000n, stake: 0n,
      pendingUnstake: 0n, reputationBps: 10_000, seqBase: 0n, seqBitmap: 0n, status: 0, syncedAt: NOW - 60 }],
  ]),
  risk: { kBps: 0, stakeReference: 1n, hardCap: 10n ** 12n, stakePrice: 0n, haircutBps: 0 },
  riskSyncedAt: NOW - 60,
  fullSyncAt: NOW - 60,
};

function nodeDb(): SqlDb {
  const d = new DatabaseSync(":memory:");
  return {
    execAsync: async (sql) => void d.exec(sql),
    runAsync: async (sql, ...p) => d.prepare(sql).run(...p),
    getAllAsync: async <T,>(sql: string, ...p: (string | number | null)[]) => d.prepare(sql).all(...p) as T[],
    getFirstAsync: async <T,>(sql: string, ...p: (string | number | null)[]) =>
      ((d.prepare(sql).get(...p) as T | undefined) ?? null),
  };
}

test("two customers, no merchant, no network: A pays B, and B keeps it to settle", async () => {
  // B asks for 7.25 USDC.
  const owed = 7_250_000n;
  const code = receiveCode(B, owed, USDC);

  // A's phone reads B's code exactly as it reads a till's.
  const request = readMerchantCode(code, USDC);
  assert.ok(request.ok, request.ok ? "" : request.reason);
  if (!request.ok) return;
  assert.equal(request.merchant, B);
  assert.equal(request.amount, owed);

  let saved: IssuerState = initialState(A_VAULT, A_DEVICE, chain);
  const store: IssuerStore = { load: async () => saved, save: async (s) => void (saved = s) };
  const issued = await pay(
    store,
    async (m) => p256.sign(m, A_KEY, { prehash: true, lowS: true }).toCompactRawBytes(),
    { merchant: request.merchant, amount: request.amount, now: NOW },
    (n) => new Uint8Array(n).fill(9),
  );
  assert.ok(issued.ok);
  if (!issued.ok) return;
  const shown = toQr(issued.packet);

  // B's phone checks it offline, as a till would, and keeps it.
  const db = voucherDb(async () => nodeDb());
  await db.saveCache(cache);
  const checked = scan({ text: shown, cache: await db.loadCache(), merchant: B, charged: owed, queued: await db.queue.all(), now: NOW });
  assert.equal(checked.kind, "take", checked.kind === "refused" ? checked.reason : checked.kind);
  if (checked.kind !== "take") return;
  const added = enqueue(() => undefined, checked.packet, NOW * 1000);
  assert.equal(added.kind, "added");
  if (added.kind === "added") await db.add(added.entry, added.entry.amount, "USDC");
  const kept: Entry[] = await db.queue.all();
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.merchant, B, "it settles to B's wallet");
  assert.equal(kept[0]!.amount, owed);

  // Shown again to B: refused. Shown to C: refused, it pays B.
  const replay = scan({ text: shown, cache, merchant: B, charged: owed, queued: kept, now: NOW + 5 });
  assert.equal(replay.kind, "refused");
  const elsewhere = scan({ text: shown, cache, merchant: C, charged: owed, queued: [], now: NOW + 5 });
  assert.equal(elsewhere.kind, "refused");
});

test("a receive code is an ordinary Solana Pay request, and never for nothing", () => {
  assert.equal(
    receiveCode(B, 1_500_000n, USDC),
    `solana:${B}?amount=1.5&spl-token=${USDC}&label=Nelo`,
  );
  assert.throws(() => receiveCode(B, 0n, USDC));
});
