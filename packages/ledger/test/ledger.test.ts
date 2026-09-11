import { test } from "node:test";
import assert from "node:assert/strict";
import {
  closeOfDay,
  dayLabel,
  formatTime,
  groupByDay,
  localDayKey,
  salesOn,
  totalsFor,
  type Sale,
} from "../src/index.ts";

/** West Africa Time, UTC+1 — the worked example in the plan. */
const WAT = 60;
/** Chatham Islands, UTC+12:45 — offsets are not whole hours everywhere. */
const CHATHAM = 765;

function sale(at: string, localMinor: bigint, over = false): Sale {
  return {
    reference: `ref-${at}`,
    signature: `sig-${at}`,
    localMinor,
    currency: "NGN",
    amountBaseUnits: localMinor * 10n,
    mint: "usdc",
    at: Date.parse(at),
    overpaid: over,
  };
}

// ------------------------------------------------------- day boundaries ---

test("a late-evening sale belongs to the merchant's day, not UTC's", () => {
  // 23:50 in Lagos is already 22:50 UTC the same day — but at UTC+1 the danger
  // is the other direction: 23:30 UTC is 00:30 tomorrow locally.
  assert.equal(localDayKey(Date.parse("2026-09-11T22:50:00Z"), WAT), "2026-09-11");
  assert.equal(localDayKey(Date.parse("2026-09-11T23:30:00Z"), WAT), "2026-09-12");
});

test("UTC midnight is not the merchant's midnight", () => {
  const atUtcMidnight = Date.parse("2026-09-12T00:00:00Z");
  assert.equal(localDayKey(atUtcMidnight, 0), "2026-09-12");
  assert.equal(localDayKey(atUtcMidnight, WAT), "2026-09-12");
  // Behind UTC, it is still the previous day.
  assert.equal(localDayKey(atUtcMidnight, -300), "2026-09-11");
});

test("handles offsets that are not whole hours", () => {
  assert.equal(localDayKey(Date.parse("2026-09-11T11:00:00Z"), CHATHAM), "2026-09-11");
  assert.equal(localDayKey(Date.parse("2026-09-11T11:20:00Z"), CHATHAM), "2026-09-12");
});

test("rolls month and year correctly", () => {
  assert.equal(localDayKey(Date.parse("2026-09-30T23:30:00Z"), WAT), "2026-10-01");
  assert.equal(localDayKey(Date.parse("2026-12-31T23:30:00Z"), WAT), "2027-01-01");
});

// --------------------------------------------------------------- totals ---

test("totals sum in integers", () => {
  const totals = totalsFor([
    sale("2026-09-11T09:00:00Z", 150_000n),
    sale("2026-09-11T10:00:00Z", 25_050n),
    sale("2026-09-11T11:00:00Z", 1n),
  ]);
  assert.equal(totals.count, 3);
  assert.equal(totals.localMinor, 175_051n);
  assert.equal(totals.amountBaseUnits, 1_750_510n);
});

test("totals of nothing are zero, not NaN", () => {
  const totals = totalsFor([]);
  assert.equal(totals.count, 0);
  assert.equal(totals.localMinor, 0n);
  assert.equal(totals.amountBaseUnits, 0n);
});

test("overpayments are counted, not hidden", () => {
  const totals = totalsFor([
    sale("2026-09-11T09:00:00Z", 100n, true),
    sale("2026-09-11T10:00:00Z", 100n),
  ]);
  assert.equal(totals.overpaidCount, 1);
});

// -------------------------------------------------------------- grouping ---

test("groups into local days, newest first", () => {
  const sales = [
    sale("2026-09-10T09:00:00Z", 100n),
    sale("2026-09-11T09:00:00Z", 200n),
    sale("2026-09-11T14:00:00Z", 300n),
  ];
  const days = groupByDay(sales, WAT);
  assert.deepEqual(days.map((d) => d.day), ["2026-09-11", "2026-09-10"]);
  assert.equal(days[0]!.totals.localMinor, 500n);
  // Newest sale first within the day.
  assert.equal(days[0]!.sales[0]!.localMinor, 300n);
});

test("a sale after local midnight lands on the next day's sheet", () => {
  const sales = [
    sale("2026-09-11T22:00:00Z", 100n), // 23:00 local, 11th
    sale("2026-09-11T23:30:00Z", 900n), // 00:30 local, 12th
  ];
  const days = groupByDay(sales, WAT);
  assert.deepEqual(days.map((d) => d.day), ["2026-09-12", "2026-09-11"]);
  assert.equal(days[0]!.totals.localMinor, 900n);
  assert.equal(days[1]!.totals.localMinor, 100n);
});

test("close of day counts only that day", () => {
  const sales = [
    sale("2026-09-10T09:00:00Z", 100n),
    sale("2026-09-11T09:00:00Z", 200n),
    sale("2026-09-11T14:00:00Z", 300n),
  ];
  const close = closeOfDay(sales, "2026-09-11", WAT);
  assert.equal(close.count, 2);
  assert.equal(close.localMinor, 500n);
  assert.equal(closeOfDay(sales, "2026-09-09", WAT).count, 0);
});

test("salesOn returns newest first", () => {
  const sales = [
    sale("2026-09-11T09:00:00Z", 100n),
    sale("2026-09-11T14:00:00Z", 300n),
  ];
  assert.deepEqual(
    salesOn(sales, "2026-09-11", WAT).map((s) => s.localMinor),
    [300n, 100n],
  );
});

// ------------------------------------------------------------- display ---

test("times render in the merchant's own clock", () => {
  assert.equal(formatTime(Date.parse("2026-09-11T13:05:00Z"), WAT), "14:05");
  assert.equal(formatTime(Date.parse("2026-09-11T23:30:00Z"), WAT), "00:30");
});

test("labels today and yesterday relative to the merchant", () => {
  const now = Date.parse("2026-09-11T12:00:00Z");
  assert.equal(dayLabel("2026-09-11", now, WAT), "Today");
  assert.equal(dayLabel("2026-09-10", now, WAT), "Yesterday");
  assert.equal(dayLabel("2026-09-01", now, WAT), "2026-09-01");
});
