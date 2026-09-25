/**
 * The voucher store against Node's own SQLite, through the same four calls
 * expo-sqlite makes on the phone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { enqueue, type Entry } from "@nelo/queue";
import { emptyCache } from "@nelo/enrol";
import { encode } from "@nelo/voucher";
import { voucherDb, type SqlDb } from "../src/index.ts";

function nodeDb(path = ":memory:"): SqlDb {
  const d = new DatabaseSync(path);
  return {
    execAsync: async (sql) => void d.exec(sql),
    runAsync: async (sql, ...p) => d.prepare(sql).run(...p),
    getAllAsync: async <T,>(sql: string, ...p: (string | number | null)[]) => d.prepare(sql).all(...p) as T[],
    getFirstAsync: async <T,>(sql: string, ...p: (string | number | null)[]) =>
      ((d.prepare(sql).get(...p) as T | undefined) ?? null),
  };
}

function entry(seq: bigint, amount = 5_000_000n): Entry {
  const packet = encode({
    version: 1,
    vault: new Uint8Array(32).fill(0x11),
    seq,
    amount,
    remainingAfter: 0n,
    merchant: new Uint8Array(32).fill(0x22),
    expiresAt: 2_000_000_000n,
    salt: new Uint8Array(8),
    signature: new Uint8Array(64).fill(1),
    devicePubkey: new Uint8Array(33).fill(2),
  });
  const r = enqueue(() => undefined, packet, 1_000);
  assert.equal(r.kind, "added");
  return (r as { entry: Entry }).entry;
}

test("a voucher taken is kept, with what was charged, and taking it twice keeps the first", async () => {
  const s = voucherDb(async () => nodeDb());
  const e = entry(1n);
  await s.add(e, 750_000n, "NGN");
  await s.add({ ...e, attempts: 9 }, 1n, "NGN");
  const all = await s.taken();
  assert.equal(all.length, 1);
  assert.equal(all[0]!.localMinor, 750_000n);
  assert.equal(all[0]!.entry.attempts, 0);
  assert.deepEqual(all[0]!.entry.packet, e.packet);
});

test("the queue's writes land, and only settled vouchers are offered for booking, once", async () => {
  const s = voucherDb(async () => nodeDb());
  const a = entry(1n);
  const b = entry(2n);
  await s.add(a, 1n, "NGN");
  await s.add(b, 2n, "NGN");
  await s.queue.put({ ...a, status: "settled", settledSignature: "sig" });
  const due = await s.unbooked();
  assert.deepEqual(due.map((t) => t.entry.id), [a.id]);
  await s.markBooked(a.id);
  assert.deepEqual(await s.unbooked(), []);
  assert.equal((await s.queue.all()).find((x) => x.id === a.id)!.settledSignature, "sig");
});

test("a double spend is kept until reported, with both packets exact", async () => {
  const s = voucherDb(async () => nodeDb());
  const a = entry(3n, 1n).packet;
  const b = entry(3n, 2n).packet;
  await s.addConflict("v:3", a, b);
  const [c] = await s.unreported();
  assert.deepEqual(c!.a, a);
  assert.deepEqual(c!.b, b);
  await s.markReported("v:3", "reported");
  assert.deepEqual(await s.unreported(), []);
});

test("the payer list round-trips, and a phone that never synced gets an empty one", async () => {
  const s = voucherDb(async () => nodeDb());
  assert.deepEqual(await s.loadCache(), emptyCache());
  await s.saveCache(emptyCache());
  assert.deepEqual(await s.loadCache(), emptyCache());
});

test("everything survives closing and reopening the file", async (t) => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const path = join(mkdtempSync(join(tmpdir(), "nelo-store-")), "till.db");
  const first = voucherDb(async () => nodeDb(path));
  const e = entry(4n);
  await first.add(e, 5n, "NGN");
  const again = voucherDb(async () => nodeDb(path));
  assert.deepEqual((await again.taken()).map((x) => x.entry.id), [e.id]);
  t.diagnostic(path);
});
