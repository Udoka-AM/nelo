/**
 * Payout destinations. This is the field that decides where a merchant's money
 * actually goes, so the round trip is tested as a round trip and the one
 * unverified check is tested as being non-blocking.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeDestination,
  nubanCheckDigit,
  parseCanonical,
  toCanonical,
  validateBankAccount,
  validateMobileMoney,
  type PayoutDestination,
} from "../src/payout.ts";

const good = (r: ReturnType<typeof validateBankAccount>) => {
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  return r.ok ? r : (undefined as never);
};

const bad = (r: ReturnType<typeof validateBankAccount>) => {
  assert.equal(r.ok, false, "expected a refusal");
  return r.ok ? (undefined as never) : r;
};

// ------------------------------------------------------------ bank shape ---

test("a NUBAN-shaped Nigerian account is accepted", () => {
  const r = good(validateBankAccount("NG", "058", "0123456789"));
  assert.deepEqual(r.destination, {
    method: "bank",
    market: "NG",
    institution: "058",
    account: "0123456789",
  });
});

test("spaces and dashes in a typed account are tolerated", () => {
  // A merchant reading off a card types it in groups.
  assert.equal(good(validateBankAccount("NG", "058", "0123 456 789")).ok, true);
  assert.equal(
    good(validateBankAccount("NG", "058", "012-345-6789")).destination.method,
    "bank",
  );
});

/** Shape blocks. A 9-digit NUBAN is a typo, not an edge case. */
test("a wrong-length Nigerian account is refused, with the expected shape named", () => {
  assert.match(bad(validateBankAccount("NG", "058", "012345678")).reason, /10-digit/);
  assert.match(bad(validateBankAccount("NG", "058", "01234567890")).reason, /10-digit/);
});

test("a missing or malformed bank code sends the merchant back to the list", () => {
  assert.match(bad(validateBankAccount("NG", "", "0123456789")).reason, /from the list/);
  assert.match(bad(validateBankAccount("NG", "58", "0123456789")).reason, /from the list/);
  assert.match(bad(validateBankAccount("NG", "abc", "0123456789")).reason, /from the list/);
});

/**
 * The Philippines has no NUBAN equivalent, so the rules are deliberately looser.
 * Being permissive is the decision — the alternative is refusing valid accounts
 * at banks whose formats nobody here has enumerated.
 */
test("the Philippines accepts a bounded digit string, and says the bound", () => {
  good(validateBankAccount("PH", "BDO", "123456"));
  good(validateBankAccount("PH", "BPI", "12345678901234567890"));
  assert.match(bad(validateBankAccount("PH", "BDO", "12345")).reason, /6 to 20/);
  assert.match(bad(validateBankAccount("PH", "BDO", "1".repeat(21))).reason, /6 to 20/);
});

// -------------------------------------------------- the NUBAN check digit ---

test("the check digit is deterministic and in range", () => {
  for (const serial of ["012345678", "999999999", "000000000", "123456789"]) {
    const d = nubanCheckDigit("058", serial);
    assert.ok(d !== null && d >= 0 && d <= 9, `serial ${serial} → ${d}`);
    assert.equal(d, nubanCheckDigit("058", serial), "same input, same answer");
  }
});

test("the check digit refuses inputs it cannot compute from", () => {
  assert.equal(nubanCheckDigit("58", "012345678"), null);
  assert.equal(nubanCheckDigit("058", "01234567"), null);
  assert.equal(nubanCheckDigit("058", "0123456789"), null);
  assert.equal(nubanCheckDigit("abc", "012345678"), null);
});

/**
 * The property that keeps this honest. The algorithm has **not** been validated
 * against real account numbers, so a mismatch must never block — it warns.
 *
 * Refusing a merchant's actual account on an unverified algorithm is a lost
 * merchant; accepting a typo is a payout the partner bounces with a reason.
 */
/** Narrows unconditionally: a fixture that cannot be computed is a broken test. */
function checkDigitFor(institution: string, serial: string): number {
  const d = nubanCheckDigit(institution, serial);
  if (d === null) throw new Error(`fixture ${institution}/${serial} has no check digit`);
  return d;
}

test("a check-digit mismatch warns and does not block", () => {
  const serial = "012345678";
  const correct = checkDigitFor("058", serial);

  const wrong = (correct + 1) % 10;
  const r = good(validateBankAccount("NG", "058", `${serial}${wrong}`));
  assert.equal(r.ok, true, "a mismatch must still be accepted");
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /transposed/);
});

test("a matching check digit produces no warning", () => {
  const serial = "012345678";
  // Not `nubanCheckDigit` directly: a null would interpolate as "null" and the
  // test would quietly assert something else entirely.
  const correct = checkDigitFor("058", serial);
  const r = good(validateBankAccount("NG", "058", `${serial}${correct}`));
  assert.deepEqual(r.warnings, []);
});

test("a market with no check-digit scheme never warns about one", () => {
  assert.deepEqual(good(validateBankAccount("PH", "BDO", "123456")).warnings, []);
});

// ---------------------------------------------------------- mobile money ---

test("mobile money reuses phone normalisation", () => {
  const r = validateMobileMoney("NG", "0803 123 4567");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.destination, {
      method: "mobile_money",
      market: "NG",
      e164: "+2348031234567",
    });
  }
});

test("a non-mobile number is refused as a mobile-money destination too", () => {
  // Mobile money pays a phone. If SMS cannot reach it, neither can the payout.
  const r = validateMobileMoney("NG", "6031234567");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /not a mobile number/i);
});

// ----------------------------------------------------- the canonical form ---

/**
 * The round trip is the contract with `@nelo/settle`: whatever goes into
 * `DisburseRequest.destination` has to come back out as the same destination,
 * or the two ends of the payout leg agree by convention instead of by type.
 */
test("every destination survives the round trip", () => {
  const cases: PayoutDestination[] = [
    { method: "bank", market: "NG", institution: "058", account: "0123456789" },
    { method: "bank", market: "PH", institution: "BDO", account: "123456789" },
    { method: "mobile_money", market: "NG", e164: "+2348031234567" },
    { method: "mobile_money", market: "PH", e164: "+639171234567" },
  ];

  for (const destination of cases) {
    const canonical = toCanonical(destination);
    const parsed = parseCanonical(canonical);
    assert.equal(parsed.ok, true, `${canonical}: ${parsed.ok ? "" : parsed.reason}`);
    if (parsed.ok) assert.deepEqual(parsed.destination, destination, canonical);
  }
});

test("the canonical form is the shape settle expects", () => {
  assert.equal(
    toCanonical({ method: "bank", market: "NG", institution: "058", account: "0123456789" }),
    "bank:NG:058:0123456789",
  );
  assert.equal(
    toCanonical({ method: "mobile_money", market: "NG", e164: "+2348031234567" }),
    "momo:NG:+2348031234567",
  );
});

/**
 * Parsing re-validates rather than trusting the string. It may have come off a
 * phone, out of a database, or from a partner callback — and a destination that
 * is wrong is money going somewhere else.
 */
test("a canonical string carrying a bad destination is refused on the way back", () => {
  assert.equal(parseCanonical("bank:NG:058:012345678").ok, false, "short account");
  assert.equal(parseCanonical("bank:NG:58:0123456789").ok, false, "bad bank code");
  assert.equal(parseCanonical("momo:NG:+2340123456789").ok, false, "not a mobile number");
});

test("malformed canonical strings are refused rather than half-parsed", () => {
  for (const input of [
    "",
    "bank",
    "bank:NG",
    "bank:NG:058",
    "bank:NG:058:0123456789:extra",
    "momo:NG",
    "cheque:NG:058:0123456789",
    "bank:GB:058:0123456789",
    "momo:ZZ:+2348031234567",
  ]) {
    assert.equal(parseCanonical(input).ok, false, `"${input}" should be refused`);
  }
});

// -------------------------------------------------------------- display ---

test("a destination shown to a merchant does not print the whole account", () => {
  // Enough to recognise, not enough to read over someone's shoulder.
  assert.equal(
    describeDestination({
      method: "bank",
      market: "NG",
      institution: "058",
      account: "0123456789",
    }),
    "Bank account ••••6789",
  );
  assert.equal(
    describeDestination({ method: "mobile_money", market: "NG", e164: "+2348031234567" }),
    "Mobile money ••••4567",
  );
});
