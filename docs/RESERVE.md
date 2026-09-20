# The reserve requirement

The week-2 gate asks for this one directly:

> **Model the reserve requirement this week** — the SKR premium is priced off it, and the
> deck asserts that. An unmodelled multiplier is a number this panel will ask about.

This is that model. It lives in [`packages/reserve`](../packages/reserve), runs off-device,
and every conclusion below is a passing test.

```bash
pnpm --filter @nelo/reserve report    # print it
pnpm --filter @nelo/reserve test      # 17 tests
```

---

## Read this first

**Eleven of the inputs are guesses.** Nobody has measured them. They are graded in
[`src/assumptions.ts`](../packages/reserve/src/assumptions.ts) — `plan` for figures stated in
`BUILD.md`, `assumed` for everything else — and the report prints the `assumed` list before
any result, so the gap travels with the output.

So the model does not say what the reserve *is*. It says **what would have to be true**, and
which three or four numbers are worth going and finding out. Treat every figure below as
conditional on inputs that a week of real trading in week 4 would settle.

---

## What it computes

The plan already states the exposure, in §4:

> Worst case per vault per offline session is roughly
> `floor_limit × merchants_reached − locked_balance`. […] The residual is an ordinary
> insurance line — which is exactly how card schemes have priced floor-limit risk for fifty
> years.

The model turns that into a number, nets off the staked first-loss capital, treats overspend
attempts across the platform as a Poisson count, and covers the tail at a chosen confidence.

At the default assumptions — 1,000 vaults, $50 base limit, 20 merchants reachable, $200
locked, 10 bps attempt rate, 99.5% coverage:

| | |
|---|---:|
| Loss reaching the reserve, per attempt | **$800** |
| Expected attempts per month | 4.0 |
| Attempts covered at 99.5% | 10 |
| **Reserve required (stock)** | **$8,000** |
| Expected loss per month | $3,200 |

---

## Four findings

### 1 · The 0.20% line did not cover the losses it exists to cover — **fixed**

`BUILD.md` §7 carried an insurance reserve line of 0.20% of volume. At these assumptions:

| | |
|---|---:|
| 0.20% line raised per month | $2,280 |
| Expected loss per month | $3,200 |
| **Shortfall** | **$920/month** |
| Line implied by expected loss | **28.07 bps** |
| Line in the plan | 20.0 bps |

**Acted on.** The line charged is now **29 bps**, carried by `INSURANCE_RESERVE_BPS` in
`services/settle/src/money.ts` and by `reserveLineBps` here. It raises $3,306 a month against
$3,200 of expected loss, a $106 surplus, and the stock funds in 2.4 months rather than 3.5.

The rate rounds **up** from 28.07 rather than to nearest: at 28 bps the line raises $3,192 and
still would not cover, so rounding to nearest would have preserved the exact shortfall this
finding exists to name. A reserve that over-collects a little is the survivable error.

The cost is 9 bps off the take rate — the unit economics table now reads **0.61%, not 0.70%**.

Separately, and not the same question: the reserve is a *stock*, the line is a *flow*. Even
at the corrected rate, it takes **2.4 months** of the line to accumulate the $8,000. Until then
the exposure sits on the balance sheet. A reserve that is correctly sized in steady state
still needs funding on day one.

### 2 · The Trust Stake curve makes things worse before it makes them better

This is the result that was not obvious, and it constrains `k`.

Staking raises the offline limit — and the limit is multiplied by every merchant the payer can
reach, while the stake only covers itself once. Because √ has an unbounded slope at zero, a
*small* stake adds more exposure than it absorbs. The crossover is where that reverses:

```
M · dF/ds = 1   ⇒   s* = (M · base · k / 2)² / ref
```

At the defaults, **s\* = $250 of staked value**. Below it, letting a payer stake makes the
platform's position worse. The Trust Stake as currently parameterised starts on the wrong side
of that line, because stake starts at zero.

Two levers, and the second is cheaper:

- **Require a minimum stake** of at least `s*` before the curve applies at all.
- **Lower `k`.** The crossover goes as `k²`, so halving `k` quarters it — to about **$62.50**,
  which a small merchant could plausibly hold.

Either is a `RiskConfig` update, not a redeploy. That is exactly why those parameters were left
as configuration when the curve shipped.

### 3 · The hard cap is not doing any work

With base $50 and `k = 1.0`, reaching the $500 cap takes **$81,000 of staked value**:

| Staked value | Offline limit |
|---:|---:|
| $0 | $50 |
| $250 | $75 |
| $1,000 | $100 |
| $10,000 | $208 |
| $81,000 | $500 — the cap |

No small merchant will ever approach it, so the cap binds nothing and the real ceiling is
whatever the curve happens to produce. Either the cap should come down to where it binds, or
`k` should come up — but `k` coming up pushes the crossover in finding 2 further out, since it
moves as `k²`. **The two have to be set together.**

### 4 · Reserve relief cannot fund the illustrative premium

§5 is explicit that the premium must be derived, not picked:

> Nelo can pay up to the value of the capital it saves. Model the reserve requirement first and
> derive the multiplier from it — an illustrative 1.5× is a placeholder until that model
> exists, not a promise.

Derived, above the crossover:

| Stake per vault | Reserve freed per $1 staked | Annual saving | Ceiling |
|---:|---:|---:|---:|
| $500 | $0.003 | 0.044% | 1.0004× |
| $1,000 | $0.007 | 0.075% | 1.0008× |
| $2,500 | $0.010 | 0.103% | 1.0010× |

**About 1.001×, not 1.5×.**

The reason is dilution, and it is structural rather than a matter of tuning the inputs. A staked
dollar reduces the loss of the vault that *defaults* by a dollar — but the platform holds stake
from every vault, and only ~10 of 1,000 default in the covered case. So reserve released per
dollar of platform-wide stake is `covered_attempts / staking_vaults`, not 1.

The hedge in §5 was well placed. What has to change is the *description*: a premium above
roughly 1.001× is being paid out of the rebate budget as acquisition cost, or justified by
Guardian yield accruing to the merchant — both defensible — but it **cannot be described as
priced off capital relief**. Four of six judges are infrastructure, tooling or security people,
and that is the sentence they will test.

---

## What is most worth measuring

The reserve is **super-linear** in merchants reachable — elasticity 1.25, because collateral is
netted off once and everything above it scales:

| Merchants reachable | Reserve required |
|---:|---:|
| 10 | $3,000 |
| 20 | $8,000 |
| 40 | $18,000 |

It is also the input with the least behind it. One afternoon in the committed shop counting how
many distinct merchants a customer could plausibly reach in one offline trip is worth more than
any refinement of the maths here.

---

## A gap this model assumes rather than closes

The exposure priced here is a payer signing successive sequences that each carry a plausible
`remaining_after`, together exceeding their collateral. The replay window closes double-spending
**at one sequence**, and `report_conflict` freezes a vault on two vouchers at the *same*
sequence — but two vouchers at *different* sequences whose `remaining_after` values are
inconsistent are not a conflict by that definition, so they do not trigger the freeze.

That is the residual the insurance line exists for, and the plan is explicit that it is priced
rather than eliminated. It is worth deciding deliberately whether `report_conflict` should also
accept an inconsistent-`remaining_after` pair as proof — it would shorten the window in which a
compromised device keeps trading. **Not changed here**; it is a design decision, not a modelling
one.

---

## Where the numbers go

- `base`, `k` and `hard_cap` are the `RiskConfig` account in
  [`programs/nelo_vault`](../programs/nelo_vault/src/state.rs), set by instruction. Findings 2
  and 3 are config changes.
- The reserve and rebate lines are `INSURANCE_RESERVE` and `REBATE_PAYABLE` in
  [`services/settle`](../services/settle/src/accounts.ts), which already accrues both per sale.
  Finding 1 is a rate change in `money.ts`.
- The deck's unit economics and premium slides are where findings 1 and 4 have to be reflected
  before submission.
