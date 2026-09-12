/**
 * The arithmetic the money splits are made of.
 *
 * Pure and integer-only, and separated from the ledger so the sums can be
 * argued about on their own. Every rounding direction here is a decision about
 * who absorbs the fraction, and each one is stated rather than inherited from
 * whatever the operator happened to do.
 *
 * The rates are those in docs/BUILD.md §7 — and, as that table says in bold,
 * they are a model, not a forecast. They live here as named constants so that
 * replacing one with a real number is a one-line change somebody can find.
 */

/** Basis points. 10_000 bps = 100%. */
export const BPS = 10_000n;

/**
 * Platform fee on settled volume, charged to the merchant. Deliberately below
 * typical card acceptance cost, which is the entire commercial argument.
 */
export const PLATFORM_FEE_BPS = 50n;

/** Funds the offline guarantee. Comes out of the platform's own take. */
export const INSURANCE_RESERVE_BPS = 20n;

/**
 * Trust Stake rebate — 20% of the platform fee, bought on the open market.
 * Nothing is minted. See docs/BUILD.md §5.
 */
export const REBATE_BPS = 10n;

/**
 * Round **down**, always, on any share of someone else's money.
 *
 * `bigint` division truncates toward zero, which for a negative numerator is
 * rounding *up* in magnitude — so negatives are handled explicitly rather than
 * left to a surprise. Amounts here should never be negative; the guard is
 * cheap and the alternative is a fee that grows on a refund.
 */
export function shareOf(amount: bigint, bps: bigint): bigint {
  if (amount < 0n) throw new RangeError("shareOf expects a non-negative amount");
  if (bps < 0n) throw new RangeError("shareOf expects non-negative basis points");
  return (amount * bps) / BPS;
}

export interface SaleSplit {
  /** What the customer paid, in settlement-token minor units. */
  gross: bigint;
  /** Our fee. */
  platformFee: bigint;
  /** What the merchant is owed. */
  net: bigint;
  /** Set aside against the offline guarantee. */
  reserve: bigint;
  /** Accrued to the merchant, payable in cash or SKR at their election. */
  rebate: bigint;
}

/**
 * Split a settled sale.
 *
 * `net` is computed by subtraction rather than by its own percentage, so the
 * fee and the merchant's share always add back to exactly what the customer
 * paid. Computing both independently is how a ledger ends up a unit short on
 * odd amounts, every time, forever.
 */
export function splitSale(
  gross: bigint,
  rates: {
    platformFeeBps?: bigint;
    reserveBps?: bigint;
    rebateBps?: bigint;
  } = {},
): SaleSplit {
  if (gross < 0n) throw new RangeError("a sale cannot be negative");
  const platformFee = shareOf(gross, rates.platformFeeBps ?? PLATFORM_FEE_BPS);
  return {
    gross,
    platformFee,
    net: gross - platformFee,
    reserve: shareOf(gross, rates.reserveBps ?? INSURANCE_RESERVE_BPS),
    rebate: shareOf(gross, rates.rebateBps ?? REBATE_BPS),
  };
}

/**
 * A conversion rate, as integer numerator over a power of ten.
 *
 * The same shape `@nelo/pay` uses for the till, for the same reason: a naira
 * rate with eight decimal places does not survive a float.
 */
export interface ConversionRate {
  /** Local minor units per one settlement-token minor unit, scaled. */
  localPerToken: bigint;
  /** Power of ten `localPerToken` is scaled by. */
  scale: number;
}

export function convert(tokenMinor: bigint, rate: ConversionRate): bigint {
  if (tokenMinor < 0n) throw new RangeError("cannot convert a negative amount");
  if (rate.localPerToken < 0n) throw new RangeError("a rate cannot be negative");
  return (tokenMinor * rate.localPerToken) / 10n ** BigInt(rate.scale);
}

export interface PayoutSplit {
  /** What left the merchant's dollar balance. */
  tokenMinor: bigint;
  /** What the partner's rate produces. */
  partnerLocalMinor: bigint;
  /** What the merchant is credited, at the rate they were quoted. */
  merchantLocalMinor: bigint;
  /** The difference, and our revenue on the conversion. */
  spreadLocalMinor: bigint;
}

/**
 * Split a payout across the two rates.
 *
 * The spread is **not** a percentage applied to a total — it is the gap between
 * the rate the partner gives us and the rate we quote the merchant, computed as
 * a difference. That means rounding cannot invent or destroy a minor unit: both
 * sides round down independently and the spread absorbs whatever is left.
 *
 * It also means the spread can come out at zero, or negative if somebody quotes
 * the merchant better than the partner gives. Negative is refused here, loudly,
 * because it is a pricing mistake and not something to discover in a month's
 * revenue figures.
 */
export function splitPayout(
  tokenMinor: bigint,
  partnerRate: ConversionRate,
  merchantRate: ConversionRate,
): PayoutSplit {
  const partnerLocalMinor = convert(tokenMinor, partnerRate);
  const merchantLocalMinor = convert(tokenMinor, merchantRate);
  const spreadLocalMinor = partnerLocalMinor - merchantLocalMinor;
  if (spreadLocalMinor < 0n) {
    throw new RangeError(
      "the merchant is quoted a better rate than the partner gives — that is a loss, not a spread",
    );
  }
  return { tokenMinor, partnerLocalMinor, merchantLocalMinor, spreadLocalMinor };
}
