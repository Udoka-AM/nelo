/**
 * The model's arithmetic, and the properties its conclusions rest on.
 *
 * A model nobody can check is a number with a story attached. Every claim the
 * report makes is pinned here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, DOLLAR, unsourcedInputs, values } from "../src/assumptions.ts";
import { floorLimit, isqrt, type CurveParams } from "../src/curve.ts";
import {
  crossoverStakeValue,
  marginalExposurePerStake,
  perVaultExposure,
  poissonQuantile,
  premiumCeiling,
  reserveLineVerdict,
  reserveRequirement,
  sensitivityTo,
  volumes,
} from "../src/model.ts";

const v = values(DEFAULTS);

// ------------------------------------------- the curve mirror vs. Rust ---

/**
 * The same fixture as `programs/nelo_vault/src/curve.rs`: base $50, k = 1.0,
 * one reference unit = $1,000. If these drift apart, the model is describing a
 * limit the chain will not enforce.
 */
const RUST_FIXTURE: CurveParams = {
  base: 50 * DOLLAR,
  kBps: 10_000,
  stakeReference: 1_000 * DOLLAR,
  hardCap: 2_000 * DOLLAR,
};

test("the curve mirror reproduces the on-chain worked values", () => {
  // `zero_stake_leaves_the_base_limit_untouched`
  assert.equal(floorLimit(RUST_FIXTURE, 0), 50 * DOLLAR);
  // `staking_raises_the_limit_sublinearly`: 1 + √1 = 2
  assert.equal(floorLimit(RUST_FIXTURE, 1_000 * DOLLAR), 100 * DOLLAR);
  // 4× the stake buys 2× the uplift, not 4×: 1 + √4 = 3
  assert.equal(floorLimit(RUST_FIXTURE, 4_000 * DOLLAR), 150 * DOLLAR);
  assert.equal(floorLimit(RUST_FIXTURE, 9_000 * DOLLAR), 200 * DOLLAR);
});

test("the mirror caps where the program caps", () => {
  // `the_limit_saturates_and_stops_rewarding_more_collateral`, tight cap $150.
  const capped = { ...RUST_FIXTURE, hardCap: 150 * DOLLAR };
  assert.equal(floorLimit(capped, 4_000 * DOLLAR), 150 * DOLLAR);
  assert.equal(floorLimit(capped, 9_000 * DOLLAR), 150 * DOLLAR);
  assert.equal(floorLimit(capped, 1_000_000 * DOLLAR), 150 * DOLLAR);
});

test("isqrt floors", () => {
  assert.equal(isqrt(0), 0);
  assert.equal(isqrt(8), 2);
  assert.equal(isqrt(9), 3);
  assert.equal(isqrt(10), 3);
});

// ------------------------------------------------------------ the tail ---

test("the Poisson quantile matches a hand-computed table", () => {
  // Poisson(1): P(X≤0)=.368, ≤1=.736, ≤2=.920, ≤3=.981
  assert.equal(poissonQuantile(1, 0.3), 0);
  assert.equal(poissonQuantile(1, 0.5), 1);
  assert.equal(poissonQuantile(1, 0.9), 2, "P(X≤2)=.920 already clears .9");
  assert.equal(poissonQuantile(1, 0.95), 3);
  // Poisson(4) at 99.5% — the figure the default assumptions land on.
  assert.equal(poissonQuantile(4, 0.995), 10);
});

test("a zero rate needs no cover, and a confidence of 1 is refused", () => {
  assert.equal(poissonQuantile(0, 0.999), 0);
  assert.throws(() => poissonQuantile(4, 1), RangeError);
});

// ---------------------------------------------------------- exposure ---

test("exposure is the plan's own formula", () => {
  // docs/BUILD.md §4: floor_limit × merchants_reached − locked_balance
  const e = perVaultExposure(v);
  assert.equal(e.limitPerVoucher, 50 * DOLLAR);
  assert.equal(e.grossPerSession, 1_000 * DOLLAR);
  assert.equal(e.lossToReserve, 800 * DOLLAR);
});

test("collateral that covers the whole session leaves nothing for the reserve", () => {
  const covered = { ...v, lockedCollateral: 5_000 * DOLLAR };
  assert.equal(perVaultExposure(covered).lossToReserve, 0);
  assert.equal(reserveRequirement(covered).reserveRequired, 0);
});

// --------------------------------------------------------- crossover ---

/**
 * The finding that constrains `k`. Staking raises the limit, and the limit is
 * multiplied by every merchant reached — so below the crossover a staked dollar
 * adds more exposure than it covers.
 */
test("the crossover is where a staked dollar stops making things worse", () => {
  const s = crossoverStakeValue(v);

  // Hand-check: (M·base·k/2)² / ref = (20 × $50 / 2)² / $1,000 = $250.
  assert.equal(s, 250 * DOLLAR);

  assert.ok(marginalExposurePerStake(v, s * 0.5) > 0, "below: more stake, more exposure");
  assert.ok(marginalExposurePerStake(v, s * 2) < 0, "above: more stake, less exposure");
});

test("staking below the crossover really does raise the reserve requirement", () => {
  const s = crossoverStakeValue(v);
  const unstaked = reserveRequirement(v, 0).reserveRequired;
  const barelyStaked = reserveRequirement(v, s * 0.1).reserveRequired;
  assert.ok(
    barelyStaked > unstaked,
    `a token stake should worsen the position: ${unstaked} → ${barelyStaked}`,
  );
});

test("a smaller k moves the crossover within reach", () => {
  // The lever: the crossover goes as k², so halving k quarters it.
  const halved = crossoverStakeValue({ ...v, curveKBps: v.curveKBps / 2 });
  assert.equal(halved, crossoverStakeValue(v) / 4);
});

// --------------------------------------------- the plan's reserve line ---

/**
 * The headline. At the default assumptions the 0.20% line in docs/BUILD.md §7
 * does not fund the expected loss it exists to fund.
 */
test("the plan's 0.20% reserve line does not cover expected loss at these inputs", () => {
  const verdict = reserveLineVerdict(v);
  assert.equal(verdict.coversExpectedLoss, false);
  assert.ok(verdict.shortfallPerMonth > 0);
  assert.ok(
    verdict.impliedReserveLineBps > v.reserveLineBps,
    `implied ${verdict.impliedReserveLineBps} vs planned ${v.reserveLineBps}`,
  );
});

test("the verdict keeps the flow and the stock apart", () => {
  const verdict = reserveLineVerdict(v);
  const vol = volumes(v);
  // A line is a flow; the requirement is a stock. Months-to-fund is the bridge.
  assert.equal(verdict.monthsToFund, verdict.reserveRequired / vol.reserveFundingPerMonth);
  assert.ok(verdict.monthsToFund > 0);
});

// ------------------------------------------------------- the premium ---

/**
 * §5 says the premium must be derived from capital saved, not picked. Derived,
 * it is nowhere near the deck's illustrative 1.5×.
 */
test("reserve relief alone cannot fund the illustrative premium", () => {
  const s = crossoverStakeValue(v);
  for (const multiple of [2, 4, 10]) {
    const p = premiumCeiling(v, s * multiple);
    assert.ok(p.multiplier > 1, "above the crossover, stake does save capital");
    assert.ok(
      p.multiplier < 1.05,
      `at ${multiple}× crossover the ceiling is ${p.multiplier}, not ${p.illustrativeMultiplier}`,
    );
  }
});

test("the offset is diluted by every vault that stakes and never defaults", () => {
  const s = crossoverStakeValue(v) * 4;
  const few = premiumCeiling(v, s, 10);
  const many = premiumCeiling(v, s, 10_000);
  assert.ok(
    few.reserveOffsetPerStakedDollar > many.reserveOffsetPerStakedDollar,
    "concentrating stake on the vaults that actually default would be worth more",
  );
});

// ----------------------------------------------------- sensitivity ---

test("the reserve is close to linear in the least-known input", () => {
  const s = sensitivityTo(v, "merchantsReached");
  assert.ok(s.high.reserveRequired > s.base.reserveRequired);
  assert.ok(s.low.reserveRequired < s.base.reserveRequired);
  // Doubling the merchants reached more than doubles the loss, because
  // collateral is netted off once and the rest scales.
  assert.ok(s.elasticity > 1, `elasticity ${s.elasticity} should exceed 1`);
});

// ------------------------------------------------------- discipline ---

test("the model refuses to look better sourced than it is", () => {
  const unsourced = unsourcedInputs();
  assert.ok(unsourced.length > 0, "if this is ever empty, check it is true");
  for (const { input } of unsourced) {
    assert.ok(input.source.length > 20, "every guess says what would settle it");
  }
});
