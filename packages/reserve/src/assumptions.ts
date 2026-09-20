/**
 * Every number the reserve model runs on, in one place, each one labelled with
 * where it came from.
 *
 * This file is the whole point of the package. A reserve model is only as good
 * as its inputs, and the failure mode is not a wrong formula — it is a
 * plausible-looking figure that nobody can source, quoted back six months later
 * as though it were measured. So each input carries a `source`, and the three
 * grades are kept honestly apart:
 *
 *   - `plan`      — stated in docs/BUILD.md. Still a model, not a measurement,
 *                   but at least it is the team's own stated assumption.
 *   - `derived`   — computed from something else here, not independently chosen.
 *   - `assumed`   — **nobody has a real figure.** A guess, placed here so it is
 *                   visible rather than buried in a formula.
 *
 * `unsourcedInputs()` lists every `assumed` input. Anything it returns is a
 * question for the commercial side, not for the code — and the model's own
 * report prints the list, so the gap travels with the output.
 */

export type Grade = "plan" | "derived" | "assumed";

export interface Input<T = number> {
  value: T;
  /** What this is, in one line a non-engineer can check. */
  what: string;
  grade: Grade;
  /** Where the value came from, or what would have to happen to know it. */
  source: string;
}

const input = <T>(value: T, what: string, grade: Grade, source: string): Input<T> => ({
  value,
  what,
  grade,
  source,
});

/**
 * Money is in **settlement-token minor units** — USDC at 6 dp, so 50_000_000 is
 * $50. Kept as `number` rather than `bigint` deliberately: this model computes a
 * policy figure, not a payment. Nothing here ever moves money, and the square
 * roots and tail probabilities below have no integer form. Every path that
 * *does* move money is integer-only — see `@nelo/pay` and `@nelo/settle`.
 */
export const DOLLAR = 1_000_000;

export interface Assumptions {
  // ---- the offline exposure, per docs/BUILD.md §4 ----
  baseFloorLimit: Input;
  merchantsReached: Input;
  lockedCollateral: Input;
  stakeValuePerVault: Input;

  // ---- the curve, per docs/BUILD.md §5 ----
  curveKBps: Input;
  stakeReference: Input;
  hardCap: Input;

  // ---- the population ----
  activeVaults: Input;
  offlineSessionsPerVaultPerMonth: Input;
  overspendAttemptRate: Input;

  // ---- the policy ----
  coverageConfidence: Input;
  costOfCapitalAnnualBps: Input;

  // ---- for the cross-check against the plan's own unit economics ----
  merchantDailyTurnover: Input;
  shareCapturedOnNelo: Input;
  offlineShareOfVolume: Input;
  reserveLineBps: Input;
  rebateLineBps: Input;
}

/**
 * The default set.
 *
 * **Most of these are guesses.** `unsourcedInputs()` returns the current count
 * and the list; the report prints it first. Read it before quoting any number
 * this model produces.
 */
export const DEFAULTS: Assumptions = {
  baseFloorLimit: input(
    50 * DOLLAR,
    "Base offline limit per voucher, before the Trust Stake curve",
    "assumed",
    "No stated figure. $50 is a plausible largest-basket for a stall; the real number " +
      "comes from the committed shop's own till data in week 4.",
  ),
  merchantsReached: input(
    20,
    "Distinct merchants one payer can present vouchers to in a single offline session",
    "assumed",
    "The M in the plan's `floor_limit × merchants_reached − locked_balance`. Nobody has " +
      "measured it. It is the single most sensitive input in this model — see the report.",
  ),
  lockedCollateral: input(
    200 * DOLLAR,
    "Collateral a payer locks before going offline",
    "assumed",
    "Behavioural: how much a payer pre-loads. Observable from week 4 onwards.",
  ),
  stakeValuePerVault: input(
    0,
    "Staked SKR per vault, valued after haircut",
    "assumed",
    "Zero until the Trust Stake ships to real users. The model's job is to say what " +
      "this needs to be — see the crossover figure.",
  ),

  curveKBps: input(
    10_000,
    "Growth coefficient k, in bps. 10_000 means one reference unit of stake doubles the base",
    "plan",
    "docs/BUILD.md §5, shape only — the value is what this model is for. Mirrors the " +
      "test fixture in programs/nelo_vault/src/curve.rs.",
  ),
  stakeReference: input(
    1_000 * DOLLAR,
    "Stake value at which k applies in full",
    "assumed",
    "A normalising constant chosen so k is a number a person can reason about. Any " +
      "value works provided k moves with it.",
  ),
  hardCap: input(
    500 * DOLLAR,
    "Ceiling on any single vault's offline limit",
    "assumed",
    "Bounds worst-case exposure per vault. Should be set from the largest basket the " +
      "business is willing to guarantee, not from the curve.",
  ),

  activeVaults: input(
    1_000,
    "Vaults transacting offline in the period",
    "plan",
    "docs/BUILD.md §7 models unit economics at 1,000 merchants.",
  ),
  offlineSessionsPerVaultPerMonth: input(
    4,
    "Distinct offline sessions per vault per month",
    "assumed",
    "One outage or dead-zone trip a week. Unmeasured.",
  ),
  overspendAttemptRate: input(
    0.001,
    "Share of vaults attempting to overspend across sequences in a given session",
    "assumed",
    "Requires a compromised or modified device — StrongBox attestation is the barrier, " +
      "and every attempt is attributable to a hardware key with the vault frozen after. " +
      "10 bps is a placeholder with no incident data behind it.",
  ),

  coverageConfidence: input(
    0.995,
    "Share of periods the reserve must fully cover",
    "assumed",
    "A policy choice, not a measurement. 99.5% is one-bad-month-in-seventeen-years.",
  ),
  costOfCapitalAnnualBps: input(
    1_500,
    "Annual cost of the capital sitting in the reserve",
    "assumed",
    "What it costs to hold idle reserve. Sets the ceiling on what the SKR premium can be.",
  ),

  merchantDailyTurnover: input(
    95 * DOLLAR,
    "Merchant daily turnover",
    "plan",
    "docs/BUILD.md §7 unit economics table.",
  ),
  shareCapturedOnNelo: input(
    0.4,
    "Share of that turnover taken on Nelo",
    "plan",
    "docs/BUILD.md §7 unit economics table.",
  ),
  offlineShareOfVolume: input(
    0.15,
    "Share of Nelo volume taken offline rather than online",
    "assumed",
    "The offline path is the product's reason to exist, but no figure exists for how " +
      "much of real volume runs through it.",
  ),
  reserveLineBps: input(
    29,
    "Insurance reserve line charged on settled volume",
    "derived",
    "Set by this model, not by the plan. Expected loss implies 28.07 bps; the " +
      "rate rounds up to the next whole basis point because a reserve that " +
      "over-collects is the survivable error. The plan's original 0.20% is what " +
      "this replaced — see the reserve-line tests, which still pin that it did " +
      "not cover. Mirrored by INSURANCE_RESERVE_BPS in services/settle/src/money.ts.",
  ),
  rebateLineBps: input(
    10,
    "Trust Stake rebate line in the plan's unit economics",
    "plan",
    "docs/BUILD.md §7 — 0.10%, 20% of the platform fee.",
  ),
};

/** Every input nobody has a real figure for. */
export function unsourcedInputs(a: Assumptions = DEFAULTS): { key: string; input: Input }[] {
  return Object.entries(a)
    .filter(([, i]) => (i as Input).grade === "assumed")
    .map(([key, i]) => ({ key, input: i as Input }));
}

/** Shorthand: strip the labelling and hand the formulas plain numbers. */
export type Values = { [K in keyof Assumptions]: number };

export function values(a: Assumptions = DEFAULTS): Values {
  return Object.fromEntries(
    Object.entries(a).map(([key, i]) => [key, (i as Input).value]),
  ) as Values;
}
