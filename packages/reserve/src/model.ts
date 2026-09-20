/**
 * The reserve requirement, and what it says the SKR premium can be.
 *
 * The plan states the exposure directly (docs/BUILD.md §4):
 *
 *   > Worst case per vault per offline session is roughly
 *   > `floor_limit × merchants_reached − locked_balance`. […] The residual is an
 *   > ordinary insurance line — which is exactly how card schemes have priced
 *   > floor-limit risk for fifty years.
 *
 * This turns that sentence into a number, and then asks the two questions the
 * plan leaves open: is the reserve line enough — §7's original 0.20% was not — and what can the
 * platform actually afford to pay for staked SKR?
 *
 * The answer to the second one is smaller than the deck's illustrative figure.
 * That is a finding, not a bug — see `premiumCeiling`.
 */
import { floorLimit, limitSlope, type CurveParams } from "./curve.ts";
import { DEFAULTS, values, type Assumptions, type Values } from "./assumptions.ts";

export const curveFrom = (v: Values): CurveParams => ({
  base: v.baseFloorLimit,
  kBps: v.curveKBps,
  stakeReference: v.stakeReference,
  hardCap: v.hardCap,
});

// ------------------------------------------------------------- exposure ---

export interface Exposure {
  /** The limit the curve grants at this stake. */
  limitPerVoucher: number;
  /** Everything a single vault could put out in one offline session. */
  grossPerSession: number;
  /** Net of the payer's own locked collateral and staked first-loss capital. */
  lossToReserve: number;
}

/**
 * What one vault can cost the reserve in a single offline session.
 *
 * Collateral is netted because it genuinely pays the merchants at the front of
 * the queue — it is the merchants behind them who go unpaid, and only that
 * shortfall reaches the reserve. Stake is netted after it, because stake is
 * first-loss capital: it absorbs before the platform does.
 *
 * Note what this does **not** model: the replay window closes double-spending
 * *at one sequence*, but a payer signing successive sequences that each claim a
 * plausible `remaining_after` is a different attack, and `report_conflict` only
 * takes two vouchers at the same sequence. That gap is the exposure priced
 * here. See the README of this package.
 */
export function perVaultExposure(v: Values, stakeValue = v.stakeValuePerVault): Exposure {
  const limitPerVoucher = floorLimit(curveFrom(v), stakeValue);
  const grossPerSession = limitPerVoucher * v.merchantsReached;
  const lossToReserve = Math.max(0, grossPerSession - v.lockedCollateral - stakeValue);
  return { limitPerVoucher, grossPerSession, lossToReserve };
}

/**
 * The stake value at which one more dollar of stake stops *increasing* the
 * reserve requirement and starts reducing it.
 *
 * This is the result that constrains `k`, and it is not obvious. Staking raises
 * the offline limit, and the limit is multiplied by every merchant the payer can
 * reach — so a small stake adds `M × dF/ds` of exposure while only covering 1.
 * Because √ has an unbounded slope at zero, **the curve is reserve-increasing at
 * low stake.** It only turns reserve-reducing once the slope has fallen far
 * enough:
 *
 *   M · dF/ds = 1   ⇒   √(s·ref) = M·base·k / 2   ⇒   s* = (M·base·k/2)² / ref
 *
 * Below `s*`, letting a payer stake makes the platform's position worse, not
 * better. Either require at least `s*`, or lower `k`.
 */
export function crossoverStakeValue(v: Values): number {
  const k = v.curveKBps / 10_000;
  if (k === 0) return 0;
  const root = (v.merchantsReached * v.baseFloorLimit * k) / 2;
  return (root * root) / v.stakeReference;
}

/** Does one more dollar of stake here help or hurt the reserve? */
export function marginalExposurePerStake(v: Values, stakeValue: number): number {
  return v.merchantsReached * limitSlope(curveFrom(v), stakeValue) - 1;
}

// -------------------------------------------------------------- the tail ---

/**
 * Smallest `k` with `P(X ≤ k) ≥ confidence` for a Poisson of mean `lambda`.
 *
 * Poisson because overspend attempts are rare, independent and countable, which
 * is the shape this distribution is for. Computed by summing the PMF rather than
 * approximated, so it is exact for the small means involved and can be checked
 * by hand.
 */
export function poissonQuantile(lambda: number, confidence: number): number {
  if (lambda <= 0) return 0;
  if (confidence >= 1) throw new RangeError("confidence must be below 1");

  let term = Math.exp(-lambda); // P(X = 0)
  let cumulative = term;
  let k = 0;
  // Poisson has no upper bound; stop well past where any sane confidence lands.
  const ceiling = Math.max(1_000, Math.ceil(lambda * 50));
  while (cumulative < confidence && k < ceiling) {
    k += 1;
    term *= lambda / k;
    cumulative += term;
  }
  return k;
}

export interface ReserveRequirement {
  /** Expected overspend attempts across the platform, per month. */
  attemptsPerMonth: number;
  /** Attempts the reserve must cover, at the chosen confidence. */
  coveredAttempts: number;
  /** What one attempt costs. */
  lossPerAttempt: number;
  /** The stock of capital that has to exist. */
  reserveRequired: number;
  /** Expected loss, which is what the reserve line has to fund on average. */
  expectedLossPerMonth: number;
}

export function reserveRequirement(v: Values, stakeValue = v.stakeValuePerVault): ReserveRequirement {
  const { lossToReserve } = perVaultExposure(v, stakeValue);
  const attemptsPerMonth =
    v.activeVaults * v.offlineSessionsPerVaultPerMonth * v.overspendAttemptRate;
  const coveredAttempts = poissonQuantile(attemptsPerMonth, v.coverageConfidence);

  return {
    attemptsPerMonth,
    coveredAttempts,
    lossPerAttempt: lossToReserve,
    reserveRequired: coveredAttempts * lossToReserve,
    expectedLossPerMonth: attemptsPerMonth * lossToReserve,
  };
}

// -------------------------------------------------------------- volumes ---

export interface Volumes {
  totalPerMonth: number;
  offlinePerMonth: number;
  /** What the §7 reserve line raises per month. */
  reserveFundingPerMonth: number;
  /** What the §7 rebate line costs per month. */
  rebateBudgetPerMonth: number;
}

export function volumes(v: Values): Volumes {
  const totalPerMonth =
    v.merchantDailyTurnover * v.shareCapturedOnNelo * 30 * v.activeVaults;
  return {
    totalPerMonth,
    offlinePerMonth: totalPerMonth * v.offlineShareOfVolume,
    reserveFundingPerMonth: (totalPerMonth * v.reserveLineBps) / 10_000,
    rebateBudgetPerMonth: (totalPerMonth * v.rebateLineBps) / 10_000,
  };
}

export interface ReserveLineVerdict {
  reserveRequired: number;
  fundingPerMonth: number;
  /** Months of the charged line to accumulate the required stock. */
  monthsToFund: number;
  /** Does the line at least cover the expected loss as it accrues? */
  coversExpectedLoss: boolean;
  /** Monthly gap between expected loss and what the line raises. Negative = surplus. */
  shortfallPerMonth: number;
  /**
   * The line the expected loss actually implies, in bps of total volume.
   *
   * This is the number to act on: if it exceeds `reserveLineBps`, the plan's
   * unit economics are carrying a reserve line that does not fund the losses
   * it is there to fund, and the net take rate is overstated by the gap.
   */
  impliedReserveLineBps: number;
  /** Required reserve as a share of monthly offline volume. */
  shareOfOfflineVolume: number;
}

/**
 * Is the insurance line charged enough? The plan's original 0.20% was not.
 *
 * Two different questions, kept apart because conflating them is how a reserve
 * gets under-funded: the line is a *flow* and the requirement is a *stock*. A
 * line that covers expected loss every month still leaves the business exposed
 * until the stock has accumulated.
 */
export function reserveLineVerdict(v: Values, stakeValue = v.stakeValuePerVault): ReserveLineVerdict {
  const requirement = reserveRequirement(v, stakeValue);
  const vol = volumes(v);
  return {
    reserveRequired: requirement.reserveRequired,
    fundingPerMonth: vol.reserveFundingPerMonth,
    monthsToFund:
      vol.reserveFundingPerMonth > 0
        ? requirement.reserveRequired / vol.reserveFundingPerMonth
        : Infinity,
    coversExpectedLoss: vol.reserveFundingPerMonth >= requirement.expectedLossPerMonth,
    shortfallPerMonth: requirement.expectedLossPerMonth - vol.reserveFundingPerMonth,
    impliedReserveLineBps:
      vol.totalPerMonth > 0
        ? (requirement.expectedLossPerMonth / vol.totalPerMonth) * 10_000
        : Infinity,
    shareOfOfflineVolume:
      vol.offlinePerMonth > 0 ? requirement.reserveRequired / vol.offlinePerMonth : Infinity,
  };
}

// -------------------------------------------------------- the premium ---

export interface PremiumCeiling {
  /** Reserve released per dollar of platform-wide staked value. */
  reserveOffsetPerStakedDollar: number;
  /** Annual capital cost that releases, per dollar staked. */
  annualSavingPerStakedDollar: number;
  /** The most the platform can pay, as a multiple of the cash rebate. */
  multiplier: number;
  /** The figure the deck currently shows, for comparison. */
  illustrativeMultiplier: number;
}

/**
 * What the platform can afford to pay a merchant for electing SKR.
 *
 * §5 is explicit that this must be derived rather than picked: *"Nelo can pay up
 * to the value of the capital it saves. Model the reserve requirement first and
 * derive the multiplier from it — an illustrative 1.5× is a placeholder until
 * that model exists, not a promise."*
 *
 * The derivation, and the part that is easy to get wrong: a dollar of stake
 * reduces the loss of the vault that *defaults* by a dollar, but the platform
 * holds stake from every vault, and only `coveredAttempts` of them default in
 * the covered case. So the reserve released per dollar of **platform-wide**
 * stake is `coveredAttempts / stakingVaults`, not 1. That ratio is the whole
 * answer, and at any realistic population it is small.
 *
 * Which is why the number this returns is nowhere near 1.5×. The premium may
 * still be worth paying — out of the rebate budget, as acquisition cost, or
 * justified by Guardian yield accruing to the merchant rather than by capital
 * relief — but it cannot honestly be described as *priced off* reserve savings.
 */
export function premiumCeiling(
  v: Values,
  stakeValue = v.stakeValuePerVault,
  stakingVaults = v.activeVaults,
  holdingPeriodYears = 1,
): PremiumCeiling {
  const { coveredAttempts } = reserveRequirement(v, stakeValue);

  // Above the crossover a staked dollar nets against the loss one-for-one; below
  // it, the limit it unlocks grows faster than it covers, and the offset is
  // negative. `marginalExposurePerStake` is `dL/ds`, so the reserve moves by
  // `coveredAttempts × dL/ds` and the offset is the negative of that.
  const marginal = marginalExposurePerStake(v, stakeValue);
  const perDefaultingVault = -marginal;
  const reserveOffsetPerStakedDollar =
    stakingVaults > 0 ? (coveredAttempts * perDefaultingVault) / stakingVaults : 0;

  const annualSavingPerStakedDollar =
    reserveOffsetPerStakedDollar * (v.costOfCapitalAnnualBps / 10_000);

  return {
    reserveOffsetPerStakedDollar,
    annualSavingPerStakedDollar,
    multiplier: 1 + annualSavingPerStakedDollar * holdingPeriodYears,
    illustrativeMultiplier: 1.5,
  };
}

// ------------------------------------------------------- sensitivity ---

export interface Sensitivity {
  input: string;
  low: { value: number; reserveRequired: number };
  base: { value: number; reserveRequired: number };
  high: { value: number; reserveRequired: number };
  /** Change in reserve per 1% change in the input, at the base point. */
  elasticity: number;
}

/**
 * How much the answer moves when an input nobody has measured moves.
 *
 * Worth running on every `assumed` input, but `merchantsReached` is the one that
 * matters: it multiplies the limit directly, so the reserve is close to linear
 * in it, and it is pure guesswork.
 */
export function sensitivityTo(
  v: Values,
  key: keyof Values,
  lowFactor = 0.5,
  highFactor = 2,
): Sensitivity {
  const at = (value: number) => reserveRequirement({ ...v, [key]: value }).reserveRequired;
  const baseValue = v[key];
  const baseReserve = at(baseValue);
  const highReserve = at(baseValue * highFactor);

  return {
    input: key,
    low: { value: baseValue * lowFactor, reserveRequired: at(baseValue * lowFactor) },
    base: { value: baseValue, reserveRequired: baseReserve },
    high: { value: baseValue * highFactor, reserveRequired: highReserve },
    elasticity:
      baseReserve > 0 ? (highReserve - baseReserve) / baseReserve / (highFactor - 1) : 0,
  };
}

export const modelFrom = (a: Assumptions = DEFAULTS) => values(a);
