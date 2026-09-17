/**
 * Where the merchant's money is going.
 *
 * Onboarding collects a bank account or a mobile-money number. That value ends
 * up as `DisburseRequest.destination` in `@nelo/settle` — a single `string`,
 * because that is what a partner API takes.
 *
 * A bank payout needs **two** facts though: which institution, and which
 * account. So the string has to carry both, and it has to be parseable back,
 * or the two ends of the payout leg agree by convention instead of by type.
 * `toCanonical` / `parseCanonical` are that round trip, and they are tested as
 * a round trip rather than in one direction.
 *
 * ## What is validated, and what deliberately is not
 *
 * Shape is checked and **blocks**: a 9-digit NUBAN is a typo, full stop.
 *
 * The NUBAN check digit is computed and **does not block** — see
 * `nubanCheckDigit`. Rejecting a real merchant's account because of an
 * algorithm nobody has validated against real account numbers is a worse
 * failure than accepting a typo the partner will bounce.
 *
 * Nothing here can confirm an account *exists*. Only the partner can, via a
 * name-enquiry call, and that is the right place for it.
 */
import { normalisePhone, type Market } from "./phone.ts";

export type PayoutMethod = "bank" | "mobile_money";

export interface BankDestination {
  method: "bank";
  market: Market;
  /** Institution code as the market publishes it. */
  institution: string;
  account: string;
}

export interface MobileMoneyDestination {
  method: "mobile_money";
  market: Market;
  /** Already normalised — mobile money pays a phone number. */
  e164: string;
}

export type PayoutDestination = BankDestination | MobileMoneyDestination;

export type PayoutResult =
  | { ok: true; destination: PayoutDestination; warnings: string[] }
  | { ok: false; reason: string };

interface BankRules {
  /** Institution code shape. */
  institution: RegExp;
  /** Account number shape. */
  account: RegExp;
  /** Whether a check digit can be computed for this market. */
  checkDigit: boolean;
  hint: string;
}

const BANK_RULES: Readonly<Record<Market, BankRules>> = {
  // NUBAN is a genuine standard: a 3-digit CBN institution code and a 10-digit
  // account whose last digit is a check digit.
  NG: {
    institution: /^\d{3}$/,
    account: /^\d{10}$/,
    checkDigit: true,
    hint: "a 10-digit account number",
  },
  // The Philippines has no NUBAN equivalent — account length varies by bank, so
  // the only honest check is a bounded digit string. Being permissive here is
  // deliberate: the alternative is rejecting valid accounts at banks whose
  // format nobody on this team has enumerated.
  PH: {
    institution: /^[A-Za-z0-9]{1,11}$/,
    account: /^\d{6,20}$/,
    checkDigit: false,
    hint: "an account number of 6 to 20 digits",
  },
};

/**
 * The NUBAN check digit, per the CBN scheme: weights 3,7,3 repeating across the
 * 3-digit institution code followed by the 9-digit account serial.
 *
 * **Advisory only, and it must stay that way until somebody verifies it against
 * real account numbers.** It is implemented because it catches transposed
 * digits, and it is non-blocking because the cost of being wrong is refusing a
 * merchant's actual account — which is a support call and a lost merchant,
 * against the alternative of a payout the partner bounces with a clear reason.
 *
 * Returns `null` when the input is not the right shape to compute one.
 */
export function nubanCheckDigit(institution: string, serial: string): number | null {
  if (!/^\d{3}$/.test(institution) || !/^\d{9}$/.test(serial)) return null;

  const digits = `${institution}${serial}`;
  const weights = [3, 7, 3, 3, 7, 3, 3, 7, 3, 3, 7, 3];
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    sum += Number(digits[i]) * weights[i];
  }
  const remainder = sum % 10;
  return remainder === 0 ? 0 : 10 - remainder;
}

/** Validate a bank destination. Shape blocks; the check digit warns. */
export function validateBankAccount(
  market: Market,
  institution: string,
  account: string,
): PayoutResult {
  const rules = BANK_RULES[market];
  if (!rules) return { ok: false, reason: `${market} is not a supported market` };

  const inst = institution.trim();
  const acct = account.trim().replace(/[\s-]/g, "");

  if (!rules.institution.test(inst)) {
    return { ok: false, reason: "Choose the bank from the list" };
  }
  if (!rules.account.test(acct)) {
    return { ok: false, reason: `That should be ${rules.hint}` };
  }

  const warnings: string[] = [];
  if (rules.checkDigit) {
    const expected = nubanCheckDigit(inst, acct.slice(0, 9));
    if (expected !== null && expected !== Number(acct[9])) {
      // Surfaced, never fatal. See nubanCheckDigit.
      warnings.push("Check the account number — the digits may have been transposed");
    }
  }

  return {
    ok: true,
    destination: { method: "bank", market, institution: inst, account: acct },
    warnings,
  };
}

/** Validate a mobile-money destination. It is a phone number, so reuse that. */
export function validateMobileMoney(market: Market, phone: string): PayoutResult {
  const result = normalisePhone(phone, market);
  if (!result.ok) return { ok: false, reason: result.reason };
  return {
    ok: true,
    destination: { method: "mobile_money", market, e164: result.e164 },
    warnings: [],
  };
}

// ------------------------------------------------ the canonical string ---

/**
 * The form that goes into `DisburseRequest.destination`.
 *
 * Colon-delimited because no field can contain a colon: institution codes are
 * alphanumeric, accounts are digits, and E.164 is `+` followed by digits. That
 * makes the parse unambiguous rather than merely usually-right.
 *
 *   bank:NG:058:0123456789
 *   momo:NG:+2348031234567
 */
export function toCanonical(destination: PayoutDestination): string {
  return destination.method === "bank"
    ? `bank:${destination.market}:${destination.institution}:${destination.account}`
    : `momo:${destination.market}:${destination.e164}`;
}

export type ParseResult =
  | { ok: true; destination: PayoutDestination }
  | { ok: false; reason: string };

/**
 * Parse the canonical form back.
 *
 * Re-validates rather than trusting the string. It may have come off a phone,
 * out of a database, or from a partner callback, and a destination that is
 * wrong is money going somewhere else.
 */
export function parseCanonical(canonical: string): ParseResult {
  const parts = canonical.split(":");

  if (parts[0] === "bank" && parts.length === 4) {
    const [, market, institution, account] = parts;
    if (!(market in BANK_RULES)) return { ok: false, reason: `unknown market ${market}` };
    const result = validateBankAccount(market as Market, institution, account);
    return result.ok
      ? { ok: true, destination: result.destination }
      : { ok: false, reason: result.reason };
  }

  if (parts[0] === "momo" && parts.length === 3) {
    const [, market, e164] = parts;
    if (!(market in BANK_RULES)) return { ok: false, reason: `unknown market ${market}` };
    const result = validateMobileMoney(market as Market, e164);
    return result.ok
      ? { ok: true, destination: result.destination }
      : { ok: false, reason: result.reason };
  }

  return { ok: false, reason: "not a canonical payout destination" };
}

/** What to show a merchant, with the account partly hidden. */
export function describeDestination(destination: PayoutDestination): string {
  if (destination.method === "bank") {
    const tail = destination.account.slice(-4);
    return `Bank account ••••${tail}`;
  }
  const tail = destination.e164.slice(-4);
  return `Mobile money ••••${tail}`;
}
