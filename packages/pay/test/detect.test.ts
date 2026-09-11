/**
 * Payment validation. Every test here is an attack or a mistake that would
 * otherwise hand over goods for nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  referenceFromBytes,
  validatePayment,
  type ExpectedPayment,
  type ParsedTransaction,
} from "../src/detect.ts";

const MERCHANT = "9EDhKVwHe5csswhp5PcY1DDwJRkfsrZKao7vsQPe7yrh";
const OTHER = "DZ5ujai6xNWYnLh9Gzw1e5dZ51uq8RUUNamj3C9JyvyJ";
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const OTHER_MINT = "5UsqUEFzRafPihpUFbcPCKUyqXKrkXxF9wzyv3zXg4HV";

const EXPECTED: ExpectedPayment = {
  recipient: MERCHANT,
  splToken: USDC,
  amountBaseUnits: 12_500_000n, // $12.50
};

function tx(opts: {
  err?: unknown;
  pre?: [string, string, string][];
  post?: [string, string, string][];
}): ParsedTransaction {
  const map = (rows?: [string, string, string][]) =>
    (rows ?? []).map(([owner, mint, amount]) => ({
      owner,
      mint,
      uiTokenAmount: { amount },
    }));
  return {
    meta: { err: opts.err ?? null, preTokenBalances: map(opts.pre), postTokenBalances: map(opts.post) },
  };
}

test("accepts an exact payment", () => {
  const result = validatePayment(
    tx({ pre: [[MERCHANT, USDC, "0"]], post: [[MERCHANT, USDC, "12500000"]] }),
    EXPECTED,
  );
  assert.equal(result.paid, true);
  if (result.paid) {
    assert.equal(result.amountBaseUnits, 12_500_000n);
    assert.equal(result.overpaid, false);
  }
});

test("accepts a first-ever payment, where the merchant had no token account", () => {
  // No pre-balance entry at all: the ATA was created by this transaction.
  const result = validatePayment(tx({ post: [[MERCHANT, USDC, "12500000"]] }), EXPECTED);
  assert.equal(result.paid, true);
});

test("accepts an overpayment, and says so", () => {
  const result = validatePayment(
    tx({ pre: [[MERCHANT, USDC, "0"]], post: [[MERCHANT, USDC, "13000000"]] }),
    EXPECTED,
  );
  assert.equal(result.paid, true);
  if (result.paid) assert.equal(result.overpaid, true);
});

// ------------------------------------------------------------- attacks ---

test("refuses an underpayment", () => {
  // The interesting one: a real transfer, a real reference, one cent short.
  const result = validatePayment(
    tx({ pre: [[MERCHANT, USDC, "0"]], post: [[MERCHANT, USDC, "12499999"]] }),
    EXPECTED,
  );
  assert.equal(result.paid, false);
  if (!result.paid) assert.match(result.reason, /underpaid/);
});

test("refuses payment to someone else", () => {
  const result = validatePayment(
    tx({ pre: [[OTHER, USDC, "0"]], post: [[OTHER, USDC, "12500000"]] }),
    EXPECTED,
  );
  assert.equal(result.paid, false);
  if (!result.paid) assert.match(result.reason, /no tokens reached the merchant/);
});

test("refuses payment in the wrong token", () => {
  // A worthless token, the right amount, the right merchant.
  const result = validatePayment(
    tx({ pre: [[MERCHANT, OTHER_MINT, "0"]], post: [[MERCHANT, OTHER_MINT, "12500000"]] }),
    EXPECTED,
  );
  assert.equal(result.paid, false);
});

test("refuses a failed transaction", () => {
  const result = validatePayment(
    tx({
      err: { InstructionError: [0, "Custom"] },
      pre: [[MERCHANT, USDC, "0"]],
      post: [[MERCHANT, USDC, "12500000"]],
    }),
    EXPECTED,
  );
  assert.equal(result.paid, false);
  if (!result.paid) assert.match(result.reason, /failed on chain/);
});

test("refuses a transaction that merely mentions the reference", () => {
  // Anyone can name any account. Moving nothing must never read as payment.
  assert.equal(validatePayment(tx({}), EXPECTED).paid, false);
});

test("refuses a withdrawal dressed up as a payment", () => {
  // Balance goes down, not up. A naive absolute-value check would pass this.
  const result = validatePayment(
    tx({ pre: [[MERCHANT, USDC, "12500000"]], post: [[MERCHANT, USDC, "0"]] }),
    EXPECTED,
  );
  assert.equal(result.paid, false);
});

test("refuses a transaction with no metadata", () => {
  assert.equal(validatePayment({ meta: null }, EXPECTED).paid, false);
  assert.equal(validatePayment({}, EXPECTED).paid, false);
});

test("sums multiple credits to the same merchant", () => {
  // A wallet may split across instructions; the total is what matters.
  const result = validatePayment(
    tx({
      pre: [[MERCHANT, USDC, "0"]],
      post: [
        [MERCHANT, USDC, "6000000"],
        [MERCHANT, USDC, "6500000"],
      ],
    }),
    EXPECTED,
  );
  assert.equal(result.paid, true);
});

// ----------------------------------------------------------- references ---

test("a reference is 32 bytes, base58", () => {
  const reference = referenceFromBytes(new Uint8Array(32).fill(9));
  assert.ok(reference.length > 30 && reference.length <= 44);
});

test("references reject the wrong length", () => {
  assert.throws(() => referenceFromBytes(new Uint8Array(31)), /32 bytes/);
});
