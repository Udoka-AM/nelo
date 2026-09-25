import { test } from "node:test";
import assert from "node:assert/strict";
import { rateToConversion, toDecimal, toJsonNumber, toMinor } from "../src/paj/decimal.ts";
import { convert } from "../src/money.ts";

test("decimals in, minor units out, exactly", () => {
  assert.equal(toMinor(100, 6), 100_000_000n);
  assert.equal(toMinor(33.11, 6), 33_110_000n);
  assert.equal(toMinor("0.000001", 6), 1n);
  assert.equal(toMinor(152500.5, 2), 15_250_050n);
  assert.equal(toMinor("007.50", 2), 750n);
  // A number that came out of float arithmetic is refused, not rounded.
  assert.throws(() => toMinor(0.1 + 0.2, 6));
});

test("more precision than the unit has is refused, or dropped toward zero when asked", () => {
  assert.throws(() => toMinor("1.0000001", 6));
  assert.equal(toMinor("1.0000009", 6, "down"), 1_000_000n);
  assert.equal(toMinor("1.1000000", 6), 1_100_000n, "trailing zeros are not precision");
  assert.throws(() => toMinor(1e-7, 6), "exponent form is refused");
  assert.throws(() => toMinor(1e21, 6));
  assert.throws(() => toMinor(Number.NaN, 6));
  assert.throws(() => toMinor("12,5", 2));
  assert.throws(() => toMinor(1234567890.1234567, 6), "more digits than a double carries");
});

test("minor units back to decimals, and to JSON numbers that serialise as the same text", () => {
  assert.equal(toDecimal(12_500_000n, 6), "12.5");
  assert.equal(toDecimal(1n, 6), "0.000001");
  assert.equal(toDecimal(100_000_000n, 6), "100");
  assert.equal(JSON.stringify({ amount: toJsonNumber(33_110_000n, 6) }), '{"amount":33.11}');
  for (let i = 0; i < 2000; i++) {
    const minor = BigInt(Math.floor(Math.random() * 1e12));
    assert.equal(toMinor(toJsonNumber(minor, 6), 6), minor);
  }
});

test("paj.cash's rate becomes the ledger's, and converts a dollar to exactly that many naira", () => {
  const r = rateToConversion(1525, 2, 6);
  assert.deepEqual(r, { localPerToken: 152_500n, scale: 6 });
  assert.equal(convert(1_000_000n, r), 152_500n, "1 USDC is ₦1,525.00");
  const fractional = rateToConversion(1525.37, 2, 6);
  assert.equal(convert(1_000_000n, fractional), 152_537n);
  assert.equal(convert(10_000_000n, fractional), 1_525_370n);
  assert.throws(() => rateToConversion(0, 2, 6));
  assert.throws(() => rateToConversion(-1, 2, 6));
});
