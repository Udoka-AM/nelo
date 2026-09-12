/**
 * The payout lifecycle, end to end on the journal.
 *
 * The invariant every test re-asserts: after any sequence of events, the whole
 * book balances in every currency. If that ever fails, nothing else here is
 * worth reading.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CUSTODY,
  DISBURSEMENT_PAYABLE,
  INSURANCE_RESERVE,
  PARTNER_RECEIVABLE,
  PAYABLE,
  PAYOUT_SPREAD_REVENUE,
  PLATFORM_FEE_REVENUE,
  REBATE_PAYABLE,
} from "../src/accounts.ts";
import { openLedger } from "../src/index.ts";
import type { ConversionRate } from "../src/money.ts";
import {
  failPayout,
  instructPayout,
  merchantBalance,
  reconcileCustody,
  settlePayout,
  settleSale,
} from "../src/settlement.ts";

const USDC = "USDC";
const NGN = "NGN";
const DOLLAR = 1_000_000n;
const M = "merchant-1";
const PARTNER = "declared-stub";
const AT = 1_789_000_000_000;

const PARTNER_RATE: ConversionRate = { localPerToken: 165_025n, scale: 6 };
const MERCHANT_RATE: ConversionRate = { localPerToken: 164_200n, scale: 6 };

function assertBookBalances(ledger: ReturnType<typeof openLedger>) {
  const out = ledger.trialBalance();
  assert.equal(out.size, 0, `book does not balance: ${[...out].map(([c, v]) => `${c} ${v}`)}`);
}

function sale(ledger: ReturnType<typeof openLedger>, signature: string, grossMinor: bigint) {
  return settleSale(ledger, {
    signature,
    merchantId: M,
    grossMinor,
    tokenCurrency: USDC,
    at: AT,
  });
}

// ----------------------------------------------------------------- sales ---

test("a settled sale credits the merchant, takes the fee, funds the reserve", () => {
  const ledger = openLedger();
  sale(ledger, "sig-1", 100n * DOLLAR);

  assert.equal(ledger.normalBalance(CUSTODY, USDC), 100n * DOLLAR, "we hold it all");
  assert.equal(merchantBalance(ledger, M, USDC), 99_500_000n, "less the 0.50% fee");
  assert.equal(ledger.normalBalance(PLATFORM_FEE_REVENUE, USDC), 500_000n);
  assert.equal(ledger.normalBalance(INSURANCE_RESERVE, USDC), 200_000n);
  assert.equal(ledger.normalBalance(`${REBATE_PAYABLE}:${M}`, USDC), 100_000n);
  assertBookBalances(ledger);
});

/** The on-chain signature is the id, so a resent confirmation cannot double-credit. */
test("the same sale signature cannot be credited twice", () => {
  const ledger = openLedger();
  assert.deepEqual(sale(ledger, "sig-1", 100n * DOLLAR), { posted: true });
  assert.deepEqual(sale(ledger, "sig-1", 100n * DOLLAR), { posted: false, reason: "duplicate" });

  assert.equal(merchantBalance(ledger, M, USDC), 99_500_000n);
  assertBookBalances(ledger);
});

test("a sale too small to carry a fee still posts", () => {
  const ledger = openLedger();
  // Every deduction rounds to zero; the zero legs are dropped rather than
  // posted, and the transaction still has to balance.
  sale(ledger, "sig-dust", 50n);
  assert.equal(merchantBalance(ledger, M, USDC), 50n);
  assert.equal(ledger.normalBalance(PLATFORM_FEE_REVENUE, USDC), 0n);
  assertBookBalances(ledger);
});

// --------------------------------------------------------------- payouts ---

test("a payout converts the merchant's claim from dollars to naira", () => {
  const ledger = openLedger();
  sale(ledger, "sig-1", 100n * DOLLAR);
  const owed = merchantBalance(ledger, M, USDC);

  const { split } = instructPayout(ledger, {
    payoutId: "p1",
    merchantId: M,
    partner: PARTNER,
    tokenMinor: owed,
    tokenCurrency: USDC,
    localCurrency: NGN,
    partnerRate: PARTNER_RATE,
    merchantRate: MERCHANT_RATE,
    at: AT,
  });

  // The dollar claim is gone — that is what stops the same dollars paying out
  // twice while the partner is still working.
  assert.equal(merchantBalance(ledger, M, USDC), 0n);
  // What is left in custody is our fee, not the merchant's money — they have
  // been paid out in full and the fee was never theirs.
  assert.equal(
    ledger.normalBalance(CUSTODY, USDC),
    ledger.normalBalance(PLATFORM_FEE_REVENUE, USDC),
    "only the fee stays behind",
  );

  assert.equal(
    ledger.normalBalance(`${DISBURSEMENT_PAYABLE}:${M}`, NGN),
    split.merchantLocalMinor,
    "now owed in naira",
  );
  assert.equal(ledger.normalBalance(`${PARTNER_RECEIVABLE}:${PARTNER}`, NGN), split.partnerLocalMinor);
  assert.equal(ledger.normalBalance(PAYOUT_SPREAD_REVENUE, NGN), split.spreadLocalMinor);
  assertBookBalances(ledger);
});

/**
 * After settlement the partner still owes us the spread. Leaving it on the
 * receivable rather than writing it off at instruction time is the difference
 * between knowing what you are owed and hoping.
 */
test("settlement clears the merchant and leaves the spread receivable", () => {
  const ledger = openLedger();
  sale(ledger, "sig-1", 100n * DOLLAR);
  const owed = merchantBalance(ledger, M, USDC);
  const { split } = instructPayout(ledger, {
    payoutId: "p1",
    merchantId: M,
    partner: PARTNER,
    tokenMinor: owed,
    tokenCurrency: USDC,
    localCurrency: NGN,
    partnerRate: PARTNER_RATE,
    merchantRate: MERCHANT_RATE,
    at: AT,
  });

  settlePayout(ledger, {
    payoutId: "p1",
    merchantId: M,
    partner: PARTNER,
    partnerReference: "STUB-p1-1",
    merchantLocalMinor: split.merchantLocalMinor,
    localCurrency: NGN,
    at: AT + 1000,
  });

  assert.equal(ledger.normalBalance(`${DISBURSEMENT_PAYABLE}:${M}`, NGN), 0n, "merchant is paid");
  assert.equal(
    ledger.normalBalance(`${PARTNER_RECEIVABLE}:${PARTNER}`, NGN),
    split.spreadLocalMinor,
    "the partner still owes us the spread",
  );
  assertBookBalances(ledger);
});

test("a settlement confirmation cannot be applied twice", () => {
  const ledger = openLedger();
  sale(ledger, "sig-1", 100n * DOLLAR);
  const { split } = instructPayout(ledger, {
    payoutId: "p1",
    merchantId: M,
    partner: PARTNER,
    tokenMinor: merchantBalance(ledger, M, USDC),
    tokenCurrency: USDC,
    localCurrency: NGN,
    partnerRate: PARTNER_RATE,
    merchantRate: MERCHANT_RATE,
    at: AT,
  });
  const confirm = () =>
    settlePayout(ledger, {
      payoutId: "p1",
      merchantId: M,
      partner: PARTNER,
      partnerReference: "STUB-p1-1",
      merchantLocalMinor: split.merchantLocalMinor,
      localCurrency: NGN,
      at: AT + 1000,
    });

  assert.deepEqual(confirm(), { posted: true });
  assert.deepEqual(confirm(), { posted: false, reason: "duplicate" });
  assert.equal(ledger.normalBalance(`${DISBURSEMENT_PAYABLE}:${M}`, NGN), 0n);
  assertBookBalances(ledger);
});

/**
 * The worst outcome this service can produce is a failed payout that leaves a
 * merchant's money in limbo. It must come back, exactly.
 */
test("a failed payout returns the merchant's dollars, exactly", () => {
  const ledger = openLedger();
  sale(ledger, "sig-1", 100n * DOLLAR);
  const owed = merchantBalance(ledger, M, USDC);

  const instruction = {
    payoutId: "p1",
    merchantId: M,
    partner: PARTNER,
    tokenMinor: owed,
    tokenCurrency: USDC,
    localCurrency: NGN,
    partnerRate: PARTNER_RATE,
    merchantRate: MERCHANT_RATE,
  };
  const { split } = instructPayout(ledger, { ...instruction, at: AT });

  failPayout(ledger, {
    ...instruction,
    split,
    reason: "partner rejected the destination account",
    at: AT + 2000,
  });

  assert.equal(merchantBalance(ledger, M, USDC), owed, "the merchant is whole again");
  assert.equal(ledger.normalBalance(CUSTODY, USDC), 100n * DOLLAR);
  assert.equal(ledger.normalBalance(`${DISBURSEMENT_PAYABLE}:${M}`, NGN), 0n);
  assert.equal(ledger.normalBalance(`${PARTNER_RECEIVABLE}:${PARTNER}`, NGN), 0n);
  assert.equal(ledger.normalBalance(PAYOUT_SPREAD_REVENUE, NGN), 0n, "unearned revenue reversed");
  assertBookBalances(ledger);
});

/** The instruction stays on the record. A reversal is not a deletion. */
test("a reversal leaves both entries in the journal", () => {
  const ledger = openLedger();
  sale(ledger, "sig-1", 100n * DOLLAR);
  const instruction = {
    payoutId: "p1",
    merchantId: M,
    partner: PARTNER,
    tokenMinor: merchantBalance(ledger, M, USDC),
    tokenCurrency: USDC,
    localCurrency: NGN,
    partnerRate: PARTNER_RATE,
    merchantRate: MERCHANT_RATE,
  };
  const { split } = instructPayout(ledger, { ...instruction, at: AT });
  failPayout(ledger, { ...instruction, split, reason: "timed out", at: AT + 1 });

  const kinds = ledger.journal().map((t) => t.kind);
  assert.deepEqual(kinds, ["sale", "payout.instructed", "payout.failed"]);
});

// -------------------------------------------------------- reconciliation ---

test("reconciliation reports drift against the chain", () => {
  const ledger = openLedger();
  sale(ledger, "sig-1", 100n * DOLLAR);
  sale(ledger, "sig-2", 25n * DOLLAR);

  const clean = reconcileCustody(ledger, USDC, 125n * DOLLAR);
  assert.equal(clean.balanced, true);
  assert.equal(clean.driftMinor, 0n);

  // A sale that landed on chain and was never posted: the chain holds more
  // than the book knows about, which is the common direction and still an
  // incident.
  const missing = reconcileCustody(ledger, USDC, 130n * DOLLAR);
  assert.equal(missing.balanced, false);
  assert.equal(missing.driftMinor, 5n * DOLLAR);

  // Money gone that the book still expects. The alarming direction.
  const short = reconcileCustody(ledger, USDC, 120n * DOLLAR);
  assert.equal(short.driftMinor, -5n * DOLLAR);
});

/** A full day, and the book still balances. */
test("a day of sales and payouts leaves the book balanced", () => {
  const ledger = openLedger();
  for (let i = 0; i < 25; i++) {
    sale(ledger, `sig-${i}`, BigInt(i + 1) * 137_000n);
  }
  const owed = merchantBalance(ledger, M, USDC);
  const { split } = instructPayout(ledger, {
    payoutId: "eod",
    merchantId: M,
    partner: PARTNER,
    tokenMinor: owed,
    tokenCurrency: USDC,
    localCurrency: NGN,
    partnerRate: PARTNER_RATE,
    merchantRate: MERCHANT_RATE,
    at: AT,
  });
  settlePayout(ledger, {
    payoutId: "eod",
    merchantId: M,
    partner: PARTNER,
    partnerReference: "STUB-eod-1",
    merchantLocalMinor: split.merchantLocalMinor,
    localCurrency: NGN,
    at: AT + 1,
  });

  assert.equal(merchantBalance(ledger, M, USDC), 0n, "paid out in full");

  // Custody holds exactly the fees earned, and the chain should agree.
  const fees = ledger.normalBalance(PLATFORM_FEE_REVENUE, USDC);
  assert.equal(reconcileCustody(ledger, USDC, fees).balanced, true);

  // And those fees have to cover what we have promised out of them: the
  // reserve against the offline guarantee and the merchant's accrued rebate.
  const promised =
    ledger.normalBalance(INSURANCE_RESERVE, USDC) +
    ledger.normalBalance(`${REBATE_PAYABLE}:${M}`, USDC);
  assert.ok(promised <= fees, `promised ${promised} out of fees of ${fees}`);

  assertBookBalances(ledger);
});
