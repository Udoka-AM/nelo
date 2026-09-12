/**
 * The journal's own rules. Every test here is a way a payments ledger goes
 * quietly wrong — the kind that reconciles fine for a month and then doesn't.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CHART, CUSTODY, PAYABLE, PLATFORM_FEE_REVENUE } from "../src/accounts.ts";
import { imbalances, Ledger, LedgerError, type Entry } from "../src/ledger.ts";

const USDC = "USDC";
const NGN = "NGN";
const open = () => new Ledger(CHART);

const tx = (id: string, entries: Entry[]) => ({ id, at: 1_789_000_000_000, kind: "test", entries });

// ------------------------------------------------------------ balancing ---

test("a transaction that does not balance is refused", () => {
  const ledger = open();
  assert.throws(
    () =>
      ledger.post(
        tx("t1", [
          { account: CUSTODY, currency: USDC, amount: 100n },
          { account: `${PAYABLE}:m1`, currency: USDC, amount: -99n },
        ]),
      ),
    (e: unknown) => e instanceof LedgerError && /does not balance/.test((e as Error).message),
  );
  assert.equal(ledger.balance(CUSTODY, USDC), 0n, "nothing was written");
});

/**
 * The failure this ledger exists to prevent. A dollar is not a naira, and a
 * transaction that sums them together would balance while being nonsense.
 */
test("currencies balance separately, not against each other", () => {
  const ledger = open();
  assert.throws(
    () =>
      ledger.post(
        tx("t1", [
          { account: CUSTODY, currency: USDC, amount: 100n },
          { account: `${PAYABLE}:m1`, currency: NGN, amount: -100n },
        ]),
      ),
    /does not balance/,
  );
});

test("a transaction touching two currencies posts when each side balances", () => {
  const ledger = open();
  const result = ledger.post(
    tx("t1", [
      { account: CUSTODY, currency: USDC, amount: 100n },
      { account: `${PAYABLE}:m1`, currency: USDC, amount: -100n },
      { account: "assets:partner_receivable:yc", currency: NGN, amount: 5_000n },
      { account: `liabilities:disbursement_payable:m1`, currency: NGN, amount: -5_000n },
    ]),
  );
  assert.deepEqual(result, { posted: true });
  assert.equal(ledger.trialBalance().size, 0, "the whole book balances");
});

test("an empty or zero-valued transaction is refused", () => {
  const ledger = open();
  assert.throws(() => ledger.post(tx("t1", [])), /no entries/);
  assert.throws(
    () =>
      ledger.post(
        tx("t2", [
          { account: CUSTODY, currency: USDC, amount: 0n },
          { account: `${PAYABLE}:m1`, currency: USDC, amount: 0n },
        ]),
      ),
    /zero entry/,
  );
});

// ----------------------------------------------------------- idempotency ---

/**
 * Retries are the normal case: a partner webhook fires twice, a relay resends,
 * an operator re-runs a batch. The second posting must change nothing.
 */
test("posting the same id twice changes nothing", () => {
  const ledger = open();
  const entries: Entry[] = [
    { account: CUSTODY, currency: USDC, amount: 100n },
    { account: `${PAYABLE}:m1`, currency: USDC, amount: -100n },
  ];

  assert.deepEqual(ledger.post(tx("sale:sig1", entries)), { posted: true });
  assert.deepEqual(ledger.post(tx("sale:sig1", entries)), {
    posted: false,
    reason: "duplicate",
  });

  assert.equal(ledger.balance(CUSTODY, USDC), 100n, "credited once, not twice");
  assert.equal(ledger.journal().length, 1);
});

/** Idempotency is on the id alone — a replay with different numbers is still a replay. */
test("a duplicate id with different amounts is still refused", () => {
  const ledger = open();
  ledger.post(
    tx("sale:sig1", [
      { account: CUSTODY, currency: USDC, amount: 100n },
      { account: `${PAYABLE}:m1`, currency: USDC, amount: -100n },
    ]),
  );
  ledger.post(
    tx("sale:sig1", [
      { account: CUSTODY, currency: USDC, amount: 999n },
      { account: `${PAYABLE}:m1`, currency: USDC, amount: -999n },
    ]),
  );
  assert.equal(ledger.balance(CUSTODY, USDC), 100n);
});

// -------------------------------------------------------------- accounts ---

/**
 * A typo would otherwise open a new account, balance against itself, and report
 * a clean trial balance with the money in the wrong place.
 */
test("an undeclared account is refused", () => {
  const ledger = open();
  assert.throws(
    () =>
      ledger.post(
        tx("t1", [
          { account: "assets:custdoy", currency: USDC, amount: 100n },
          { account: `${PAYABLE}:m1`, currency: USDC, amount: -100n },
        ]),
      ),
    /unknown account/,
  );
});

test("sub-accounts inherit their parent's type", () => {
  const ledger = open();
  assert.equal(ledger.typeOf(`${PAYABLE}:merchant-42`), "liability");
  assert.equal(ledger.typeOf("assets:partner_receivable:yellowcard"), "asset");
});

test("credit-normal balances read positive", () => {
  const ledger = open();
  ledger.post(
    tx("t1", [
      { account: CUSTODY, currency: USDC, amount: 100n },
      { account: `${PAYABLE}:m1`, currency: USDC, amount: -60n },
      { account: PLATFORM_FEE_REVENUE, currency: USDC, amount: -40n },
    ]),
  );
  // The raw figure is debit-positive; the normal one reads the way a person
  // asks the question: "how much do we owe m1?"
  assert.equal(ledger.balance(`${PAYABLE}:m1`, USDC), -60n);
  assert.equal(ledger.normalBalance(`${PAYABLE}:m1`, USDC), 60n);
  assert.equal(ledger.normalBalance(PLATFORM_FEE_REVENUE, USDC), 40n);
  assert.equal(ledger.normalBalance(CUSTODY, USDC), 100n);
});

// ----------------------------------------------------------- imbalances ---

test("imbalances reports only the currencies that are out", () => {
  const out = imbalances([
    { account: CUSTODY, currency: USDC, amount: 100n },
    { account: `${PAYABLE}:m1`, currency: USDC, amount: -100n },
    { account: "assets:partner_receivable:yc", currency: NGN, amount: 7n },
  ]);
  assert.deepEqual([...out], [[NGN, 7n]]);
});
