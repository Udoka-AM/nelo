/**
 * Turning what a merchant types into E.164.
 *
 * Onboarding starts with a phone number, and the number has to survive being
 * typed by someone standing behind a counter: `0803 123 4567`,
 * `+234 803-123-4567`, `2348031234567`. All three are the same person.
 *
 * ## The scope decision, stated rather than implied
 *
 * This does **not** reimplement libphonenumber. That library exists because
 * global numbering is a large, frequently-changing dataset, and a
 * half-remembered subset of it is worse than none — it would reject real
 * merchants while looking authoritative.
 *
 * Instead: the launch markets are supported **explicitly**, as data, and
 * anything outside them is **refused rather than guessed**. Adding a market is
 * a row in `MARKETS` plus its tests. If the product reaches enough markets that
 * the table becomes the problem, that is the point to take the dependency — not
 * before.
 *
 * ## Why mobile-only is a real constraint, not a nicety
 *
 * Onboarding authenticates by SMS, so a non-mobile line cannot complete it. The
 * merchant has to be told that specifically, rather than shown a code that will
 * never arrive.
 */

/** Markets with explicit numbering rules. Everything else is refused. */
export type Market = "NG" | "PH";

interface MarketRules {
  /** Country calling code, no `+`. */
  callingCode: string;
  /** Length of the national significant number, excluding any trunk prefix. */
  nsnLength: number;
  /** First digits that denote a mobile line. SMS cannot reach anything else. */
  mobilePrefixes: readonly string[];
  /** National trunk prefix, dropped when present. */
  trunkPrefix: string;
  /** For error messages a merchant might actually read. */
  example: string;
}

export const MARKETS: Readonly<Record<Market, MarketRules>> = {
  // Nigeria: 10-digit NSN on 7/8/9, written nationally as 11 digits with a
  // leading 0. Lagos is the plan's first market.
  NG: {
    callingCode: "234",
    nsnLength: 10,
    mobilePrefixes: ["7", "8", "9"],
    trunkPrefix: "0",
    example: "0803 123 4567",
  },
  // Philippines: 10-digit NSN on 9, written nationally as 11 with a leading 0.
  // Manila is the market Pyth actually has an FX feed for.
  PH: {
    callingCode: "63",
    nsnLength: 10,
    mobilePrefixes: ["9"],
    trunkPrefix: "0",
    example: "0917 123 4567",
  },
};

export const isMarket = (value: string): value is Market => value in MARKETS;

export type PhoneResult =
  | { ok: true; e164: string; market: Market; nsn: string }
  | { ok: false; reason: string };

/** E.164 caps the whole number, country code included, at 15 digits. */
const E164_MAX_DIGITS = 15;

/**
 * Normalise a typed phone number to E.164 for one market.
 *
 * Total — returns a reason rather than throwing, because every caller is a form
 * field that has to say something useful back to the person typing.
 */
export function normalisePhone(input: string, market: Market): PhoneResult {
  const rules = MARKETS[market];
  if (!rules) return { ok: false, reason: `${market} is not a supported market` };

  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, reason: "Enter a phone number" };

  // Spaces, dashes, brackets and a leading + are all how people write numbers.
  // Anything else is a typo worth naming rather than silently stripping.
  if (/[^\d\s+()\-.]/.test(trimmed)) {
    return { ok: false, reason: "A phone number should only contain digits" };
  }

  const digits = trimmed.replace(/\D/g, "");
  if (digits === "") return { ok: false, reason: "Enter a phone number" };
  if (digits.length > E164_MAX_DIGITS) {
    return { ok: false, reason: "That is too long to be a phone number" };
  }

  const nsn = toNationalNumber(digits, rules);
  if (nsn === null) {
    return {
      ok: false,
      reason: `That does not look like a ${market} number — try ${rules.example}`,
    };
  }

  if (!rules.mobilePrefixes.includes(nsn[0])) {
    // The one rejection worth spelling out: SMS is the whole login mechanism.
    //
    // Deliberately does not say "landline". A number of the right length whose
    // prefix is not a mobile one is not a landline either — real landlines in
    // both markets are shorter, so they fail the length check above. This
    // branch means "not a mobile line", and claiming more would be a guess
    // dressed as a diagnosis.
    return {
      ok: false,
      reason:
        `That is not a mobile number. Onboarding sends a code by SMS, so it needs a mobile line — try ${rules.example}`,
    };
  }

  return { ok: true, e164: `+${rules.callingCode}${nsn}`, market, nsn };
}

/**
 * Reduce any of the three written forms to the national significant number.
 *
 * The forms *can* collide, and the resolution rests on one property of both
 * launch markets: **no NSN begins with the trunk prefix.** NG mobiles start
 * 7/8/9 and PH mobiles start 9, while the trunk prefix is 0.
 *
 * So a string that starts with `0` is a trunk-form number, and if it is not
 * trunk-form *length* it is a malformed one — not a bare NSN that happens to
 * start with a zero. Getting that order wrong reads `0803123456` (one digit
 * short) as a complete NSN beginning `0`, and reports it as "not a mobile
 * number" when the real problem is a missing digit.
 *
 * If a market is ever added whose NSN can begin with its trunk prefix, this
 * function needs a different rule and the table alone will not carry it.
 */
function toNationalNumber(digits: string, rules: MarketRules): string | null {
  const { callingCode, nsnLength, trunkPrefix } = rules;

  // +234 803 123 4567  /  2348031234567
  if (digits.length === callingCode.length + nsnLength && digits.startsWith(callingCode)) {
    return digits.slice(callingCode.length);
  }
  // 08031234567 — and anything else starting with the trunk prefix is a
  // malformed version of this form, never a bare NSN.
  if (digits.startsWith(trunkPrefix)) {
    return digits.length === nsnLength + trunkPrefix.length
      ? digits.slice(trunkPrefix.length)
      : null;
  }
  // 8031234567
  if (digits.length === nsnLength) return digits;

  return null;
}

/** Group an E.164 number for display: `+234 803 123 4567`. */
export function formatPhone(e164: string): string {
  const match = /^\+(\d+)$/.exec(e164);
  if (!match) return e164;

  const digits = match[1];
  for (const rules of Object.values(MARKETS)) {
    if (!digits.startsWith(rules.callingCode)) continue;
    const nsn = digits.slice(rules.callingCode.length);
    if (nsn.length !== rules.nsnLength) continue;
    // 10-digit NSNs read as 3-3-4 in both launch markets.
    return `+${rules.callingCode} ${nsn.slice(0, 3)} ${nsn.slice(3, 6)} ${nsn.slice(6)}`;
  }
  return e164;
}
