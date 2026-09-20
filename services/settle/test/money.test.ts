/**
 * The splits. Every test here is a rounding decision about whose fraction it
 * is — which is exactly where a payments ledger loses a unit a day and nobody
 * can say where it went.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  convert,
  PLATFORM_FEE_BPS,
  shareOf,
  splitPayout,
  splitSale,
  type ConversionRate,
} from "../src/money.ts";

// $1.00 at six decimals.
const DOLLAR = 1_000_000n;

test("a share rounds down, so a fee is never rounded up onto the merchant", () => {
  // 0.5% of 199 is 0.995 minor units. The merchant keeps it.
  assert.equal(shareOf(199n, PLATFORM_FEE_BPS), 0n);
  assert.equal(shareOf(200n, PLATFORM_FEE_BPS), 1n);
});

test("a negative amount is refused rather than growing a fee on a refund", () => {
  assert.throws(() => shareOf(-100n, PLATFORM_FEE_BPS), RangeError);
  assert.throws(() => shareOf(100n, -1n), RangeError);
});

/**
 * The property that matters more than any individual rate: what the customer
 * paid is exactly what the merchant gets plus what we took. Computing both by
 * percentage independently is how the two stop adding up on odd amounts.
 */
test("the fee and the merchant's share always add back to the sale", () => {
  for (const gross of [0n, 1n, 7n, 99n, 100n, 101n, 999n, 12_345n, 99_999_999n]) {
    const split = splitSale(gross);
    assert.equal(
      split.net + split.platformFee,
      gross,
      `${gross} split into ${split.net} + ${split.platformFee}`,
    );
  }
});

test("a sale splits at the rates in the plan", () => {
  // $100.00
  const split = splitSale(100n * DOLLAR);
  assert.equal(split.platformFee, 500_000n, "0.50%");
  assert.equal(split.net, 99_500_000n);
  assert.equal(split.reserve, 290_000n, "0.29%");
  assert.equal(split.rebate, 100_000n, "0.10%");
});

test("a tiny sale rounds every deduction to nothing rather than to a unit", () => {
  const split = splitSale(50n); // $0.00005
  assert.equal(split.platformFee, 0n);
  assert.equal(split.net, 50n, "the merchant gets all of it");
  assert.equal(split.reserve, 0n);
  assert.equal(split.rebate, 0n);
});

test("a negative sale is refused", () => {
  assert.throws(() => splitSale(-1n), RangeError);
});

// ------------------------------------------------------------ conversion ---

/** ₦1,650.25 per dollar, on a 6-decimal token and 2-decimal naira. */
const PARTNER_RATE: ConversionRate = { localPerToken: 165_025n, scale: 6 };
/** What we quote the merchant — slightly worse, and the gap is the spread. */
const MERCHANT_RATE: ConversionRate = { localPerToken: 164_200n, scale: 6 };

test("conversion rounds down and refuses a negative", () => {
  assert.equal(convert(DOLLAR, PARTNER_RATE), 165_025n); // ₦1,650.25
  assert.throws(() => convert(-1n, PARTNER_RATE), RangeError);
  assert.throws(() => convert(1n, { localPerToken: -1n, scale: 6 }), RangeError);
});

/**
 * The spread is a difference, not a percentage of a total. That is what stops
 * rounding inventing or destroying a minor unit: both sides round down on their
 * own and the spread absorbs whatever is left.
 */
test("the payout splits add up exactly, at every amount", () => {
  for (const tokenMinor of [0n, 1n, 3n, 999n, DOLLAR, 7n * DOLLAR + 13n, 1_234_567n]) {
    const split = splitPayout(tokenMinor, PARTNER_RATE, MERCHANT_RATE);
    assert.equal(
      split.merchantLocalMinor + split.spreadLocalMinor,
      split.partnerLocalMinor,
      `${tokenMinor} did not split cleanly`,
    );
    assert.ok(split.spreadLocalMinor >= 0n);
  }
});

test("a payout splits at the two rates", () => {
  const split = splitPayout(100n * DOLLAR, PARTNER_RATE, MERCHANT_RATE);
  assert.equal(split.partnerLocalMinor, 16_502_500n, "₦165,025.00 from the partner");
  assert.equal(split.merchantLocalMinor, 16_420_000n, "₦164,200.00 to the merchant");
  assert.equal(split.spreadLocalMinor, 82_500n, "₦825.00 to us");
});

/**
 * A pricing mistake, and one that would otherwise show up as a hole in a
 * month's revenue rather than as an error at the point it was made.
 */
test("quoting the merchant better than the partner gives is refused, loudly", () => {
  assert.throws(
    () => splitPayout(DOLLAR, MERCHANT_RATE, PARTNER_RATE),
    /that is a loss, not a spread/,
  );
});

test("an equal rate is a zero spread, not an error", () => {
  const split = splitPayout(DOLLAR, PARTNER_RATE, PARTNER_RATE);
  assert.equal(split.spreadLocalMinor, 0n);
});
