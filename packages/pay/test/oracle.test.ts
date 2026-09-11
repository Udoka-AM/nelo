/**
 * Oracle guards. Each of these is a way a till can end up charging a price
 * nobody stands behind.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  confidenceBps,
  DEFAULT_GUARDS,
  quoteToRate,
  type OracleQuote,
} from "../src/oracle.ts";
import { localToTokenBaseUnits } from "../src/index.ts";

const NOW = 1_789_000_000;
const NAIRA_MINOR = 100n;

/** USD/PHP-shaped: 58.12345 pesos to the dollar, Pyth's integer-plus-exponent. */
function quote(over: Partial<OracleQuote> = {}): OracleQuote {
  return { price: 5_812_345n, expo: -5, conf: 1_000n, publishTime: NOW - 2, ...over };
}

test("converts a Pyth-shaped quote into a usable rate", () => {
  const result = quoteToRate(quote(), NOW, NAIRA_MINOR);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rate.localPerUsd, 5_812_345n);
  assert.equal(result.rate.scale, 5);
  // ₱58.12345 to the dollar: ₱58.13 should be a hair over $1.
  const oneDollarish = localToTokenBaseUnits(5_813n, result.rate);
  assert.ok(oneDollarish >= 1_000_000n && oneDollarish < 1_001_000n, `got ${oneDollarish}`);
});

test("handles a positive exponent", () => {
  // Rare, but the sign is a coin-flip to get wrong and silently 10^n out.
  // conf must scale with price: at price 58 the band has integer resolution,
  // so anything above 0 is already wider than the guard allows.
  const result = quoteToRate(quote({ price: 58n, expo: 2, conf: 0n }), NOW, NAIRA_MINOR);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.rate.localPerUsd, 5_800n);
    assert.equal(result.rate.scale, 0);
  }
});

// ----------------------------------------------------------- staleness ---

test("refuses a stale price", () => {
  const result = quoteToRate(quote({ publishTime: NOW - 120 }), NOW, NAIRA_MINOR);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /120s old/);
});

test("accepts a price right at the age limit, refuses one past it", () => {
  const atLimit = quoteToRate(
    quote({ publishTime: NOW - DEFAULT_GUARDS.maxAgeSeconds }),
    NOW,
    NAIRA_MINOR,
  );
  assert.equal(atLimit.ok, true);
  const past = quoteToRate(
    quote({ publishTime: NOW - DEFAULT_GUARDS.maxAgeSeconds - 1 }),
    NOW,
    NAIRA_MINOR,
  );
  assert.equal(past.ok, false);
});

test("refuses a quote from the future", () => {
  // A wrong device clock makes every stale price look fresh, so the other
  // direction has to be caught too.
  const result = quoteToRate(quote({ publishTime: NOW + 600 }), NOW, NAIRA_MINOR);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /future/);
});

test("tolerates a second or two of clock skew", () => {
  assert.equal(quoteToRate(quote({ publishTime: NOW + 2 }), NOW, NAIRA_MINOR).ok, true);
});

// ---------------------------------------------------------- confidence ---

test("refuses a price whose confidence band is too wide", () => {
  // ±1% on an FX pair means the oracle does not know.
  const result = quoteToRate(quote({ conf: 58_123n }), NOW, NAIRA_MINOR);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /confidence/);
});

test("confidence is computed in integers, not floats", () => {
  // A huge price with a tiny band must not round to zero or blow up.
  const bps = confidenceBps({ price: 10n ** 18n, conf: 10n ** 14n, expo: -8, publishTime: NOW });
  assert.equal(bps, 1);
});

test("a zero price is refused, not divided by", () => {
  const result = quoteToRate(quote({ price: 0n }), NOW, NAIRA_MINOR);
  assert.equal(result.ok, false);
  assert.equal(confidenceBps({ price: 0n, conf: 1n, expo: 0, publishTime: NOW }), Infinity);
});

test("a negative price is refused", () => {
  assert.equal(quoteToRate(quote({ price: -1n }), NOW, NAIRA_MINOR).ok, false);
});

test("a negative confidence is refused", () => {
  assert.equal(quoteToRate(quote({ conf: -1n }), NOW, NAIRA_MINOR).ok, false);
});

test("guards can be tightened for a nervous market", () => {
  const strict = { maxAgeSeconds: 5, maxConfidenceBps: 10 };
  assert.equal(quoteToRate(quote({ publishTime: NOW - 10 }), NOW, NAIRA_MINOR, strict).ok, false);
  assert.equal(quoteToRate(quote(), NOW, NAIRA_MINOR, strict).ok, true);
});
