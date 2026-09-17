/**
 * Phone normalisation. Every test here is a way a merchant might type their own
 * number, or a reason the flow has to refuse one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPhone, isMarket, MARKETS, normalisePhone } from "../src/phone.ts";

const ok = (input: string, market: "NG" | "PH") => {
  const r = normalisePhone(input, market);
  assert.equal(r.ok, true, `expected ${input} to parse: ${r.ok ? "" : r.reason}`);
  return r.ok ? r : (undefined as never);
};

const refused = (input: string, market: "NG" | "PH") => {
  const r = normalisePhone(input, market);
  assert.equal(r.ok, false, `expected ${input} to be refused`);
  return r.ok ? (undefined as never) : r;
};

// ------------------------------------------------------- the three forms ---

/**
 * The same person, written three ways. All three have to land on one string, or
 * the merchant who typed it differently on re-onboarding becomes a new account.
 */
test("the three written forms of a Nigerian number all normalise identically", () => {
  const expected = "+2348031234567";
  for (const written of [
    "08031234567",
    "8031234567",
    "2348031234567",
    "+2348031234567",
    "+234 803 123 4567",
    "0803 123 4567",
    "+234-803-123-4567",
    "(0803) 123-4567",
    "  08031234567  ",
  ]) {
    assert.equal(ok(written, "NG").e164, expected, `from "${written}"`);
  }
});

test("the same holds for the Philippines", () => {
  const expected = "+639171234567";
  for (const written of ["09171234567", "9171234567", "639171234567", "+63 917 123 4567"]) {
    assert.equal(ok(written, "PH").e164, expected, `from "${written}"`);
  }
});

test("every mobile prefix in each market is accepted", () => {
  for (const prefix of MARKETS.NG.mobilePrefixes) {
    ok(`0${prefix}031234567`, "NG");
  }
  for (const prefix of MARKETS.PH.mobilePrefixes) {
    ok(`0${prefix}171234567`, "PH");
  }
});

// ------------------------------------------------------------- refusals ---

/**
 * The refusal that matters most: SMS is the entire login mechanism, so a
 * non-mobile line cannot complete onboarding at all. Saying "invalid number"
 * would leave the merchant waiting for a code that cannot arrive.
 *
 * Note what the message does *not* claim. A 10-digit NSN on a non-mobile prefix
 * is not a landline either — real landlines in both markets are shorter and
 * fail on length. So the reason says "not a mobile number" and stops there.
 */
test("a non-mobile prefix is refused, and the reason names SMS", () => {
  const r = refused("6031234567", "NG");
  assert.match(r.reason, /not a mobile number/i);
  assert.match(r.reason, /SMS/i);
  assert.doesNotMatch(r.reason, /landline/i, "do not diagnose what we cannot know");
});

/**
 * Markets genuinely overlap, and that is why `market` is a required parameter
 * rather than something inferred from the digits.
 *
 * `0917…` is a real Nigerian prefix *and* a real Philippine one. The same typed
 * string is a different person depending on which market the merchant is in,
 * and no amount of digit inspection can tell you which.
 */
test("an overlapping national number resolves per market, not by guessing", () => {
  assert.equal(ok("09171234567", "NG").e164, "+2349171234567");
  assert.equal(ok("09171234567", "PH").e164, "+639171234567");
});

test("a number invalid in the given market is still refused", () => {
  // 8… is mobile in NG and not in PH, so this one does not overlap.
  refused("08031234567", "PH");
});

/**
 * A truncated trunk-form number must report the length, not the prefix.
 *
 * `0803123456` is one digit short. Read as a bare NSN it would start with `0`
 * and be reported as "not a mobile number", which sends the merchant looking
 * for the wrong mistake.
 */
test("a short trunk-form number is refused on length, with the market's example", () => {
  const short = refused("0803123456", "NG");
  assert.match(short.reason, /does not look like a NG number/);
  assert.match(short.reason, /0803 123 4567/);
  assert.doesNotMatch(short.reason, /not a mobile number/);

  const long = refused("080312345678", "NG");
  assert.match(long.reason, /does not look like a NG number/);
});

test("empty and whitespace-only input asks for a number", () => {
  assert.match(refused("", "NG").reason, /Enter a phone number/);
  assert.match(refused("   ", "NG").reason, /Enter a phone number/);
  assert.match(refused("()-", "NG").reason, /Enter a phone number/);
});

test("letters are named as the problem rather than stripped", () => {
  // Stripping would turn "0803 CALL ME" into a number and dial a stranger.
  assert.match(refused("0803ABC4567", "NG").reason, /only contain digits/);
});

test("nothing longer than E.164 permits is accepted", () => {
  assert.match(refused("1".repeat(16), "NG").reason, /too long/);
});

// ------------------------------------------------------------- the type ---

test("isMarket narrows, and refuses anything not in the table", () => {
  assert.equal(isMarket("NG"), true);
  assert.equal(isMarket("PH"), true);
  assert.equal(isMarket("GB"), false);
  assert.equal(isMarket(""), false);
  // The scope decision: an unsupported market is refused, never guessed.
  assert.equal(isMarket("KE"), false);
});

test("the national significant number comes back alongside E.164", () => {
  // The NSN is what a partner API usually wants, so it is returned rather than
  // left for the caller to slice back off.
  assert.equal(ok("08031234567", "NG").nsn, "8031234567");
});

// ------------------------------------------------------------ formatting ---

test("display grouping is reversible by normalisation", () => {
  // The round trip that matters: what is shown can be re-entered.
  const e164 = ok("08031234567", "NG").e164;
  const shown = formatPhone(e164);
  assert.equal(shown, "+234 803 123 4567");
  assert.equal(ok(shown, "NG").e164, e164);
});

test("formatting leaves anything it does not recognise alone", () => {
  assert.equal(formatPhone("+44 20 7946 0000"), "+44 20 7946 0000");
  assert.equal(formatPhone("not a number"), "not a number");
});
