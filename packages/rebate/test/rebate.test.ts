import { test } from "node:test";
import assert from "node:assert/strict";
import {
  choiceFor,
  DISCLOSURE,
  elect,
  formatMultiplier,
  fromJson,
  monthOf,
  nextMonth,
  noElections,
  quote,
} from "../src/index.ts";

const WAT = 60;
const at = (iso: string) => Date.parse(iso);
const SEP = { now: at("2026-09-24T12:00:00+01:00"), tzOffsetMinutes: WAT };

test("cash is the default, with nothing chosen", () => {
  assert.equal(choiceFor(noElections(), "2026-09"), "cash");
});

test("SKR is refused without the notice accepted, as it reads now", () => {
  const none = elect(noElections(), "skr", SEP);
  assert.equal(none.ok, false);
  const stale = elect(noElections(), "skr", { ...SEP, acknowledged: DISCLOSURE.version - 1 });
  assert.equal(stale.ok, false, "an acknowledgement of older wording does not count");
  const ok = elect(noElections(), "skr", { ...SEP, acknowledged: DISCLOSURE.version });
  assert.ok(ok.ok);
  if (ok.ok) assert.equal(ok.elections.history[0]!.disclosure, DISCLOSURE.version);
});

test("the disclosure is one plain sentence about price risk", () => {
  assert.equal(DISCLOSURE.text.split(/[.!?](\s|$)/).filter((s) => s.trim()).length, 1);
  assert.match(DISCLOSURE.text, /price/);
  assert.match(DISCLOSURE.text, /less than the cash/);
});

test("a choice applies from next month, never to the month in progress", () => {
  const r = elect(noElections(), "skr", { ...SEP, acknowledged: DISCLOSURE.version });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.from, "2026-10");
  assert.equal(choiceFor(r.elections, "2026-09"), "cash", "September keeps what it started with");
  assert.equal(choiceFor(r.elections, "2026-10"), "skr");
  assert.equal(choiceFor(r.elections, "2027-03"), "skr", "and it stays until changed");
});

test("the merchant's month is their own: 23:30 on 30 September in Lagos is still September", () => {
  assert.equal(monthOf(at("2026-09-30T22:30:00Z"), WAT), "2026-09");
  assert.equal(monthOf(at("2026-09-30T23:30:00Z"), WAT), "2026-10");
  assert.equal(nextMonth("2026-12"), "2027-01");
});

test("changing your mind before next month replaces the pending choice", () => {
  const skr = elect(noElections(), "skr", { ...SEP, acknowledged: DISCLOSURE.version });
  assert.ok(skr.ok);
  if (!skr.ok) return;
  const back = elect(skr.elections, "cash", SEP);
  assert.ok(back.ok);
  if (!back.ok) return;
  assert.deepEqual(back.elections.history, [], "back to the default: nothing to record");
  assert.equal(choiceFor(back.elections, "2026-10"), "cash");
});

test("a choice made in an earlier month is history, and a later one is added after it", () => {
  const aug = elect(noElections(), "skr", { now: at("2026-08-10T12:00:00+01:00"), tzOffsetMinutes: WAT, acknowledged: 1 });
  assert.ok(aug.ok);
  if (!aug.ok) return;
  const sep = elect(aug.elections, "cash", SEP);
  assert.ok(sep.ok);
  if (!sep.ok) return;
  assert.equal(choiceFor(sep.elections, "2026-09"), "skr", "September was already SKR");
  assert.equal(choiceFor(sep.elections, "2026-10"), "cash");
  assert.equal(sep.elections.history.length, 2);
});

test("the rebate rounds down, and SKR pays the premium on it", () => {
  // $1,234.567891 of settled sales at 10 bps.
  const q = quote(1_234_567_891n);
  assert.equal(q.cash, 1_234_567n);
  assert.equal(q.skrValue, 1_851_850n);
  assert.equal(q.premium.illustrative, true, "the placeholder says it is one");
  assert.equal(quote(9_999n).cash, 9n);
  assert.throws(() => quote(-1n));
  assert.equal(formatMultiplier(15_000n), "1.5×");
  assert.equal(formatMultiplier(10_250n), "1.025×");
});

test("stored elections round-trip, and anything malformed reads as none", () => {
  const r = elect(noElections(), "skr", { ...SEP, acknowledged: DISCLOSURE.version });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(fromJson(JSON.stringify(r.elections)), r.elections);
  assert.deepEqual(fromJson(null), noElections());
  assert.deepEqual(fromJson("{"), noElections());
  // SKR with no acknowledgement on record is not trusted.
  assert.deepEqual(fromJson(JSON.stringify({ history: [{ choice: "skr", from: "2026-10", madeAt: 1 }] })), noElections());
});
