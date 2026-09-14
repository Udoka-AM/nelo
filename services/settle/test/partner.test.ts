/**
 * The stub's one job is to be impossible to mistake for a real partner.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertMovesRealMoney,
  DeclaredStubPartner,
  type PayoutPartner,
} from "../src/partner.ts";

const RATE = { localPerToken: 165_025n, scale: 6 };
const NOW = 1_789_000_000_000;

const stub = (reject: string[] = []) =>
  new DeclaredStubPartner({
    partnerRate: RATE,
    localCurrency: "NGN",
    rejectDestinations: reject,
  });

const request = (destination: string) => ({
  payoutId: "p1",
  merchantId: "merchant-1",
  destination,
  tokenMinor: 1_000_000n,
  tokenCurrency: "USDC",
  localMinor: 165_025n,
  localCurrency: "NGN",
});

test("every quote and result declares itself a stub", async () => {
  const partner = stub();
  const quote = await partner.quote("USDC", "NGN", NOW);
  assert.equal(quote.fidelity, "stub");

  const result = await partner.disburse(request("0123456789"));
  assert.equal(result.fidelity, "stub");
});

/** So it cannot be mistaken for a partner's own reference in a log or a memo. */
test("the reference is unmistakable on sight", async () => {
  const result = await stub().disburse(request("0123456789"));
  assert.equal(result.status, "accepted");
  assert.match(result.status === "accepted" ? result.partnerReference : "", /^STUB-/);
});

test("references are unique per disbursement", async () => {
  const partner = stub();
  const a = await partner.disburse(request("0123456789"));
  const b = await partner.disburse(request("0123456789"));
  assert.notEqual(
    a.status === "accepted" && a.partnerReference,
    b.status === "accepted" && b.partnerReference,
  );
});

/**
 * The failure path has to be reachable in the demo. A payout that cannot fail
 * in testing will fail for the first time in front of a merchant.
 */
test("configured destinations are rejected, so the failure path is exercised", async () => {
  const result = await stub(["bad-account"]).disburse(request("bad-account"));
  assert.equal(result.status, "rejected");
  assert.match(result.status === "rejected" ? result.reason : "", /refused by the stub/);
});

test("a quote carries an expiry, because real quotes expire", async () => {
  const quote = await stub().quote("USDC", "NGN", NOW);
  assert.ok(quote.expiresAt > NOW);
});

test("a currency the stub was not configured for is refused, not guessed", async () => {
  await assert.rejects(() => stub().quote("USDC", "PHP", NOW), /configured for NGN/);
});

/** Nothing should be able to reach production with the stub wired in. */
test("the stub cannot be used to move real money", () => {
  assert.throws(() => assertMovesRealMoney(stub()), /refusing to disburse real money/);

  const inner = stub();
  const live: PayoutPartner = {
    name: "some-licensed-partner",
    fidelity: "live",
    quote: (t, l, now) => inner.quote(t, l, now),
    disburse: (r) => inner.disburse(r),
  };
  assert.doesNotThrow(() => assertMovesRealMoney(live));
});

test("a sandbox partner is also refused for real money", () => {
  const inner = stub();
  const sandbox: PayoutPartner = {
    name: "yc-sandbox",
    fidelity: "sandbox",
    quote: (t, l, now) => inner.quote(t, l, now),
    disburse: (r) => inner.disburse(r),
  };
  assert.throws(() => assertMovesRealMoney(sandbox), /sandbox partner/);
});
