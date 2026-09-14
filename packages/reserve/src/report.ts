/**
 * Print the model at the current assumptions.
 *
 * `pnpm --filter @nelo/reserve report`
 *
 * The unsourced inputs are printed **first**, deliberately. Every figure below
 * them inherits their uncertainty, and a reader who skips straight to the
 * reserve number should have already been told what it rests on.
 */
import { DEFAULTS, DOLLAR, unsourcedInputs, values } from "./assumptions.ts";
import {
  crossoverStakeValue,
  perVaultExposure,
  premiumCeiling,
  reserveLineVerdict,
  reserveRequirement,
  sensitivityTo,
  volumes,
} from "./model.ts";

const usd = (minor: number): string =>
  `$${(minor / DOLLAR).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const pct = (x: number, dp = 2): string => `${(x * 100).toFixed(dp)}%`;

export function report(): string {
  const v = values(DEFAULTS);
  const out: string[] = [];
  const line = (s = "") => out.push(s);

  line("NELO — RESERVE REQUIREMENT MODEL");
  line("=".repeat(62));
  line();

  const unsourced = unsourcedInputs();
  line(`INPUTS NOBODY HAS A REAL FIGURE FOR — ${unsourced.length} of them`);
  line("-".repeat(62));
  for (const { key, input } of unsourced) {
    line(`  ${key}`);
    line(`    ${input.what}`);
    line(`    currently: ${input.value}`);
  }
  line();
  line("  Every number below inherits these. None of it is a measurement.");
  line();

  const exposure = perVaultExposure(v);
  line("EXPOSURE — per vault, per offline session");
  line("-".repeat(62));
  line(`  Limit per voucher                ${usd(exposure.limitPerVoucher)}`);
  line(`  × merchants reached (${v.merchantsReached})         ${usd(exposure.grossPerSession)}`);
  line(`  − locked collateral              ${usd(v.lockedCollateral)}`);
  line(`  − staked first-loss capital      ${usd(v.stakeValuePerVault)}`);
  line(`  = reaches the reserve            ${usd(exposure.lossToReserve)}`);
  line();

  const req = reserveRequirement(v);
  line("THE INSURANCE LINE");
  line("-".repeat(62));
  line(`  Expected attempts / month        ${req.attemptsPerMonth.toFixed(2)}`);
  line(`  Covered at ${pct(v.coverageConfidence, 1)} confidence      ${req.coveredAttempts}`);
  line(`  Expected loss / month            ${usd(req.expectedLossPerMonth)}`);
  line(`  RESERVE REQUIRED (stock)         ${usd(req.reserveRequired)}`);
  line();

  const vol = volumes(v);
  const verdict = reserveLineVerdict(v);
  line("IS THE PLAN'S 0.20% LINE ENOUGH?");
  line("-".repeat(62));
  line(`  Monthly volume                   ${usd(vol.totalPerMonth)}`);
  line(`  Of which offline                 ${usd(vol.offlinePerMonth)}`);
  line(`  0.20% line raises / month        ${usd(verdict.fundingPerMonth)}`);
  line(`  Expected loss / month            ${usd(req.expectedLossPerMonth)}`);
  line(`  Covers expected loss?            ${verdict.coversExpectedLoss ? "yes" : "NO"}`);
  if (!verdict.coversExpectedLoss) {
    line(`  Shortfall / month                ${usd(verdict.shortfallPerMonth)}`);
  }
  line(`  Line implied by expected loss    ${verdict.impliedReserveLineBps.toFixed(1)} bps`);
  line(`  Line in the plan                 ${v.reserveLineBps.toFixed(1)} bps`);
  line(`  Months to fund the stock         ${verdict.monthsToFund.toFixed(1)}`);
  line(`  Reserve / monthly offline vol    ${pct(verdict.shareOfOfflineVolume)}`);
  line();

  const crossover = crossoverStakeValue(v);
  line("THE CROSSOVER — what constrains k");
  line("-".repeat(62));
  line(`  Below this staked value, staking RAISES required reserve,`);
  line(`  because the limit it unlocks is multiplied by every merchant`);
  line(`  the payer can reach, while the stake only covers itself once.`);
  line();
  line(`  Crossover stake value            ${usd(crossover)}`);
  line(`  Currently staked per vault       ${usd(v.stakeValuePerVault)}`);
  line(
    `  Verdict                          ${
      v.stakeValuePerVault >= crossover ? "above — staking helps" : "BELOW — staking hurts"
    }`,
  );
  line();

  line("WHAT THE SKR PREMIUM CAN BE");
  line("-".repeat(62));
  line("  Evaluated above the crossover — at the crossover itself the");
  line("  offset is zero by definition, which flatters nothing.");
  line();
  line("     stake/vault   reserve freed per $1   annual saving   ceiling");
  let illustrative = 1.5;
  for (const multiple of [2, 4, 10]) {
    const at = crossover * multiple;
    const p = premiumCeiling(v, at);
    illustrative = p.illustrativeMultiplier;
    line(
      `     ${usd(at).padEnd(13)} ${usd(p.reserveOffsetPerStakedDollar * DOLLAR).padEnd(21)} ` +
        `${pct(p.annualSavingPerStakedDollar, 3).padEnd(15)} ${p.multiplier.toFixed(4)}×`,
    );
  }
  line();
  line(`  The deck's illustrative figure   ${illustrative}×`);
  line();
  line("  Reserve relief alone does not fund the illustrative premium. It");
  line("  can still be worth paying — out of the rebate budget, or justified");
  line("  by Guardian yield accruing to the merchant — but it must not be");
  line("  described as PRICED OFF capital relief. See docs/RESERVE.md.");
  line();

  const s = sensitivityTo(v, "merchantsReached");
  line("SENSITIVITY — merchants reached, the least-known input");
  line("-".repeat(62));
  line(`  ${s.low.value} merchants                    ${usd(s.low.reserveRequired)}`);
  line(`  ${s.base.value} merchants                   ${usd(s.base.reserveRequired)}`);
  line(`  ${s.high.value} merchants                   ${usd(s.high.reserveRequired)}`);
  line(`  Elasticity                       ${s.elasticity.toFixed(2)}× per 1× input`);
  line();

  return out.join("\n");
}

console.log(report());
