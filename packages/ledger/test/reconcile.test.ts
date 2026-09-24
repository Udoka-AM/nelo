/**
 * Close of day with offline payments in it. What matters: nothing sold today
 * goes uncounted, nothing is counted twice, and when the till's two records
 * disagree the close says so.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileDay, type OfflinePayment, type Sale } from "../src/index.ts";

const WAT = 60;
const DAY = "2026-09-24";
const at = (hhmm: string, day = DAY) => Date.parse(`${day}T${hhmm}:00+01:00`);

function online(ref: string, when: string, localMinor: bigint): Sale {
  return {
    reference: ref,
    signature: `sig-${ref}`,
    localMinor,
    currency: "NGN",
    amountBaseUnits: localMinor * 10n,
    mint: "usdc",
    at: at(when),
    overpaid: false,
  };
}

function voucher(seq: number, when: string, state: OfflinePayment["state"], localMinor: bigint, day = DAY): OfflinePayment {
  return { id: `vault:${seq}`, takenAt: at(when, day), localMinor, amountBaseUnits: localMinor * 10n, state, why: null };
}

/** The day-book row a settled voucher gets: keyed on its id, dated when taken. */
function booked(p: OfflinePayment): Sale {
  return {
    reference: p.id,
    signature: `sig-${p.id}`,
    localMinor: p.localMinor,
    currency: "NGN",
    amountBaseUnits: p.amountBaseUnits,
    mint: "usdc",
    at: p.takenAt,
    overpaid: false,
  };
}

test("a settled offline sale is in the day-book too, and is counted once", () => {
  const v = voucher(1, "10:00", "settled", 500_00n);
  const close = reconcileDay([online("r1", "09:00", 200_00n), booked(v)], [v], DAY, WAT);
  assert.equal(close.received.online.localMinor, 200_00n);
  assert.equal(close.received.offline.localMinor, 500_00n);
  assert.equal(close.received.total.localMinor, 700_00n);
  assert.equal(close.sold.count, 2, "not three");
  assert.deepEqual(close.mismatches, []);
});

test("everything sold is received, owed, held or lost, and the parts add up", () => {
  const vs = [
    voucher(1, "10:00", "settled", 100_00n),
    voucher(2, "11:00", "owed", 200_00n),
    voucher(3, "12:00", "held", 300_00n),
    voucher(4, "13:00", "lost", 400_00n),
  ];
  const sales = [online("r1", "09:00", 50_00n), booked(vs[0]!)];
  const c = reconcileDay(sales, vs, DAY, WAT);
  assert.equal(c.owed.localMinor, 200_00n);
  assert.equal(c.held.localMinor, 300_00n);
  assert.equal(c.lost.localMinor, 400_00n);
  const parts = c.received.total.localMinor + c.owed.localMinor + c.held.localMinor + c.lost.localMinor;
  assert.equal(parts, c.sold.localMinor);
  assert.equal(c.sold.localMinor, 1_050_00n);
  assert.equal(c.sold.count, 5);
  const baseParts =
    c.received.total.amountBaseUnits + c.owed.amountBaseUnits + c.held.amountBaseUnits + c.lost.amountBaseUnits;
  assert.equal(baseParts, c.sold.amountBaseUnits);
});

test("a sale belongs to the day the goods changed hands, not the day it settled", () => {
  // Taken at 23:30 yesterday, settled this morning: yesterday's sale.
  const v = voucher(1, "23:30", "settled", 500_00n, "2026-09-23");
  const today = reconcileDay([booked(v)], [v], DAY, WAT);
  assert.equal(today.sold.count, 0);
  const yesterday = reconcileDay([booked(v)], [v], "2026-09-23", WAT);
  assert.equal(yesterday.received.offline.localMinor, 500_00n);
});

test("what is still coming from earlier days is carried, apart from today's figures", () => {
  const old = voucher(1, "15:00", "owed", 800_00n, "2026-09-22");
  const oldLost = voucher(2, "15:00", "lost", 900_00n, "2026-09-22");
  const later = voucher(3, "09:00", "owed", 700_00n, "2026-09-25");
  const c = reconcileDay([], [old, oldLost, later], DAY, WAT);
  assert.equal(c.earlierOwed.localMinor, 800_00n, "not the lost one, and not tomorrow's");
  assert.equal(c.sold.count, 0);
  assert.equal(c.owed.count, 0);
});

test("a settled payment missing from the day-book is flagged, not quietly counted", () => {
  const v = voucher(1, "10:00", "settled", 500_00n);
  const c = reconcileDay([], [v], DAY, WAT);
  assert.deepEqual(c.mismatches, [{ kind: "settled-not-booked", id: v.id }]);
});

test("a day-book row for a payment the queue says has not settled is flagged", () => {
  const v = voucher(1, "10:00", "owed", 500_00n);
  const c = reconcileDay([booked(v)], [v], DAY, WAT);
  assert.deepEqual(c.mismatches, [{ kind: "booked-not-settled", id: v.id }]);
  assert.equal(c.received.total.localMinor, 0n, "and the row is not counted as received");
  assert.equal(c.owed.localMinor, 500_00n);
});

test("a day-book row for an offline payment the queue never took is flagged", () => {
  const stray = { ...online("vault:9", "10:00", 100_00n) };
  const c = reconcileDay([stray], [], DAY, WAT);
  assert.deepEqual(c.mismatches, [{ kind: "booked-unknown", id: "vault:9" }]);
  assert.equal(c.received.online.count, 0, "it is not an online sale either");
});

test("when the two records disagree on the amount, the close says so", () => {
  const v = voucher(1, "10:00", "settled", 500_00n);
  const c = reconcileDay([{ ...booked(v), localMinor: 499_00n }], [v], DAY, WAT);
  assert.deepEqual(c.mismatches, [{ kind: "amount-differs", id: v.id }]);
});

test("lost payments are listed newest first, with why", () => {
  const a = { ...voucher(1, "10:00", "lost", 100_00n), why: "spent elsewhere" };
  const b = { ...voucher(2, "14:00", "lost", 100_00n), why: "expired" };
  const c = reconcileDay([], [a, b], DAY, WAT);
  assert.deepEqual(c.lost.items.map((p) => p.why), ["expired", "spent elsewhere"]);
});
