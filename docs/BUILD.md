# Nelo — product and business plan

Accept payments on the phone you already own. Money lands in your own currency, in your
own bank. And it keeps working when the network doesn't.

Android · Solana · USDC · Lagos first. Plan v2, October 2026.

Nelo is a payment terminal with no terminal. It is built for the merchant economy — a shop,
a stall, a salon, a driver, a hotel — but the same primitive works between any two people, so
paying a friend uses the identical rails. Everything the merchant sees is in their own currency.
Nothing in the product says the word *crypto*.

| | |
|---|---|
| **Category** | Payments acceptance — merchants first, their customers second |
| **Technical core** | P-256. The phone's secure element signs, the chain verifies. No trusted server in the value path |
| **Stage** | Product live end to end: signed Android apps, mainnet cash-out to Nigerian banks, offline payments on devnet |
| **Payout partners** | paj.cash (live, Nigeria) and UseAzza (live at launch, 9+ currencies) |
| **Run cost** | ~$70/month of infrastructure today, plus payout spread and reserve |
| **Raising** | A seed round to launch in Lagos, audit the vault program and hire the core team (§12) |

**Contents**

1. [The company](#1--the-company)
2. [What Nelo is](#2--what-nelo-is)
3. [How the money actually moves](#3--how-the-money-actually-moves)
4. [Offline, and why double-spend is closed](#4--offline-and-why-double-spend-is-closed)
5. [The Trust Stake — the SKR integration](#5--the-trust-stake--the-skr-integration)
6. [Market](#6--market)
7. [How it makes money](#7--how-it-makes-money)
8. [Distribution](#8--distribution)
9. [Stack](#9--stack)
10. [Partnerships](#10--partnerships)
11. [Operating requirements](#11--operating-requirements)
12. [Plan, team and hiring](#12--plan-team-and-hiring)
13. [Risks](#13--risks)

---

## 1 · The company

### The problem

A quarter of card payments in Nigeria fail on a bad afternoon. NIBSS recorded **29.23% of POS
transactions failing on 15 May 2026** — about 157,000 declined sales in a day — and failure
averages around 15%, reaching 25% at peak. When the network drops, the shop takes cash or loses
the sale. A terminal costs a deposit, a wait and a monthly fee, and the merchant still carries
the outage.

### What Nelo does about it

Nelo turns the Android phone a merchant already owns into the till. Customers pay with any
Solana wallet, or with nelo pay — fully offline, on both phones, against money already locked
on chain. The merchant cashes out to their own bank in about twenty seconds, in naira, and Nelo
never holds their money or their keys.

### Where it stands

- **Two signed Android apps**: nelo for business (the till) and nelo pay (the customer app).
- **A real mainnet cash-out**: merchant USDC on Solana mainnet, paid into a Nigerian bank
  account through paj.cash's production API.
- **Offline payments on devnet**: voucher signed by the phone's secure element, verified on
  chain by the secp256r1 precompile, replay refused, double spend frozen and slashed.
- **A tested codebase**: 500+ tests across the program, services and shared packages,
  in CI on every push. See [`ROADMAP.md`](ROADMAP.md) for the milestone record.

### Why now

Two facts landed in the last eighteen months and nobody has put them together: Solana's
secp256r1 precompile (mainnet, June 2025) lets a program verify the P-256 signature that
Android's secure element produces. And stablecoin settlement is now cheap and fast enough that
a ₦2,500 sale is worth settling on chain. Together they make offline, hardware-signed,
on-chain-settled payments possible on a phone a merchant already owns.

---

## 2 · What Nelo is

Three things ship together. A **merchant app** that turns an ordinary Android phone into a
payment terminal: enter an amount in local currency, take the payment by code or by tap, keep
the day-book, watch the payout. A **settlement service** that converts what arrives and pushes
it to a bank account or mobile-money wallet on a schedule. And an **offline path** that
completes a sale when neither phone has a network.

Online, the customer needs nothing special — a Solana Pay code works with any wallet they
already have. Offline needs the Nelo app on both sides, which is honest to state and is also
the growth loop: a customer who has paid that way once has a reason to keep it.

### Built for the counter, works between people

The voucher does not know what a merchant is. It names a payer, an amount, and a payee. That
means the same primitive that settles a sale also settles a transfer between two friends —
splitting a bill, paying back a loan, sending money to a cousin in the next town, all of it
offline-capable and all of it on rails already built for the shop.

This matters commercially as well as technically. Merchant acquisition is slow and
relationship-led; peer-to-peer spreads on its own. The merchant is the wedge that makes the
network worth being on, and peer transfer is what makes people stay on it between purchases.

### Currency is a setting, not a market

Nelo displays and settles in whatever currency the merchant lives in. Nigeria and the naira
appear in this document as a worked example because the failure data there is public and
unusually stark — not because the product is Nigerian. The same conditions that make it
valuable in Lagos apply in Buenos Aires, Manila, Karachi, Nairobi and Bogotá: high
card-acceptance cost, unreliable authorisation networks, and a population that already holds
dollars digitally. Two thirds of global stablecoin supply is held in emerging markets, and
S&P projects holdings across 45 of them reaching $730 billion. The product is a
currency-agnostic terminal; the launch market is a business decision made once, per corridor.

---

## 3 · How the money actually moves

1. **The merchant onboards with a phone number and a payout account.** Bank account or
   mobile-money number. A wallet is created and held for them behind the device's secure
   element; they never see a key and there is nothing for them to lose.
2. **The sale happens in local currency.** They type the amount as they always would. A price
   feed converts at the live rate. The customer pays USDC on Solana — about a second, a
   fraction of a cent in fees.
3. **The balance is displayed in local currency, held in dollars.** Deliberate. A merchant in
   a devaluing currency who holds value overnight is better off in a dollar asset converted at
   payout than in a local-currency one. They see the familiar number without the exposure.
4. **Payout runs automatically.** A licensed partner converts and disburses to the merchant's
   own bank or mobile money — nightly by default, instant on demand for a fee.
5. **The merchant never off-ramps anything.** This is the decision that separates a POS from a
   crypto POS. Off-ramping is brutal if the merchant has to do it and invisible if the platform
   does it on a schedule. A merchant who must visit an exchange to get paid will not use this
   twice.

---

## 4 · Offline, and why double-spend is closed

Two facts landed in the last year and nobody has put them together. Solana activated the
**secp256r1 precompile** on mainnet in June 2025, so a program can verify a NIST P-256
signature on chain. And P-256 is the one curve uniformly supported by **Android StrongBox**,
the phone's secure element. The secure element signs; the chain verifies. There is no trusted
server anywhere in the value path.

The critical reframe: **offline mode is a prepaid balance, not a promise to pay.** Before
going offline the payer locks funds into an on-chain vault. You cannot spend offline what you
have not already locked, which disposes of both *what if they have no money* and *what if they
do not have enough* — there is no offline transaction without collateral that provably exists
first.

### The voucher — 202 bytes, v1

| Off | Len | Field | Notes |
|----:|----:|-------|-------|
| 0 | 1 | `version` | = 1. Reject anything else outright |
| 1 | 32 | `vault` | Binds the voucher to one payer |
| 33 | 8 | `seq` | Monotonic per vault — the anti-replay handle |
| 41 | 8 | `amount` | Token base units, USDC 6 dp |
| 49 | 8 | `remaining_after` | Payer's claimed balance after — lets the merchant sanity-check offline |
| 57 | 32 | `merchant` | A voucher is not bearer; it names its payee |
| 89 | 8 | `expires_at` | Bounds how long a signed voucher can sit unredeemed |
| 97 | 8 | `salt` | Per-voucher randomness |
| 105 | 64 | `signature` | P-256 r‖s over bytes 0..105, from StrongBox |
| 169 | 33 | `device_pubkey` | Carried so the merchant can verify with no network |

*Signed message 105 bytes · total packet 202 bytes.*

> **202 bytes is a deliberate budget**
>
> It fits an NDEF record for NFC *and* a QR code at version 10, error correction level M
> (213-byte capacity in byte mode) — a 57×57 grid that scans cleanly off a phone screen. So the
> offline path is not hard-blocked on NFC, which matters because the low-cost Android handsets
> this product targets do not all have usable host card emulation. Any field added later comes
> out of that budget.

### The vault program

```rust
#[account]
pub struct Vault {
    pub owner:          Pubkey,
    pub mint:           Pubkey,     // USDC
    pub device_pubkey:  [u8; 33],   // P-256, set at enrolment
    pub attestation_id: [u8; 32],   // hash of the verified attestation chain
    pub balance:        u64,        // locked collateral
    pub seq_base:       u64,        // lowest sequence still tracked
    pub seq_bitmap:     u128,       // 128-slot replay window
    pub floor_limit:    u64,        // max per offline voucher
    pub unlock_at:      i64,        // withdrawal timelock
    pub status:         u8,
    pub bump:           u8,
}
```

> **Use a replay window, not a single counter**
>
> The obvious design is `last_seq` with a `seq > last_seq` check, and it is wrong. If merchant
> A holds voucher 5 and merchant B holds voucher 6, and B reconnects first, A's voucher dies
> through no fault of A's — the common case, not an edge case.
>
> Keep a 128-slot sliding bitmap instead, the same primitive IPsec uses for anti-replay. Reject
> `seq < seq_base`, reject `seq >= seq_base + 128`, reject an already-set bit, otherwise set it
> and advance the base while the low bit is set. Out-of-order redemption works; double-spend
> still fails. Sixteen bytes.

> **The withdrawal timelock ships in v1**
>
> Without it the attack is trivial: go offline, sign vouchers at every stall on the street, get
> home, withdraw the collateral before any merchant reconnects. `request_withdraw` starts a
> delay longer than the realistic offline window — begin at 24 hours — during which vouchers
> still redeem normally.

### What the merchant can and cannot check offline

**Can, with no network:** that the P-256 signature verifies against the carried device key;
that the key appears in the enrolment list cached at last sync; that the vault is not in the
cached revocation list; that the amount is within the floor limit and the expiry has not
passed; that `remaining_after` is consistent with the last vault balance seen.

**Cannot, by definition:** whether that sequence was already spent at another stall thirty
seconds ago. No offline system can, EMV included.

So state the exposure rather than implying it is zero. Worst case per vault per offline session
is roughly `floor_limit × merchants_reached − locked_balance`. Every attempt is
cryptographically attributable to a hardware-attested key, and the vault freezes permanently on
the first conflict. The residual is an ordinary insurance line — which is exactly how card
schemes have priced floor-limit risk for fifty years.

---

## 5 · The Trust Stake — the SKR integration

Start with what not to do. A token rewards programme reads as paying for volume, because that
is what it is; in crypto payments it has a long record of failing to retain anyone once the
rewards stop. So the money has to do a job.

It does two, and they are different jobs that must not be confused with each other:
**collateral**, which unlocks a capability and is supposed to saturate, and **earning**, which
changes behaviour at the margin and must not.

> **The mistake worth naming, because it is the obvious one**
>
> A rebate that arrives automatically, already staked, illiquid, at a fixed rate on volume the
> merchant was going to do anyway is *not an incentive*. It is a fee discount wearing an
> incentive's clothes. The merchant cannot do anything differently to get more of it, cannot
> spend it, and carries the price risk. Worse, once their offline limit covers their largest
> realistic basket, more collateral buys them literally nothing.
>
> Both halves are defensible — but only if they are built and described as two separate things.

### 1 · The rebate, and the choice that makes it an incentive

Every settled transaction generates a rebate of roughly 10bps, funded by buying SKR on the open
market from Nelo's own fee revenue. Nothing is minted. Each period the merchant **elects how it
is paid**:

- **Take it in cash — the default.** Netted into the payout and felt as a lower effective fee.
  Most small merchants want money, not a token, and pretending otherwise is how this fails in
  the field.
- **Take it in SKR — at a premium.** Paid already staked, at a multiplier over the cash rate.
  The merchant gets a bigger number, a higher offline limit, and Guardian yield on the balance.

**The premium is priced, not picked.** Every unit of merchant collateral is a unit the platform
reserve no longer has to hold against that merchant's offline exposure. Nelo can pay up to the
value of the capital it saves. Model the reserve requirement first and derive the multiplier
from it — an illustrative 1.5× is a placeholder until that model exists, not a promise.

That single election is what turns a rebate into an incentive: the merchant is choosing, every
period, between liquidity now and a larger, working balance. A choice a person actually makes
is an incentive. An automatic accrual is a discount.

### 2 · Earning more — the behaviours that scale

On top of the rebate, bonus accrual — always paid to stake — for three behaviours Nelo actually
wants more of. Each is chosen because it is expensive to fake and cheap to measure.

1. **Offline volume carries a multiplier.** The behaviour that proves the product, and the
   behaviour that creates the risk collateral exists to cover. A merchant earning more
   *because* they take more of the risky kind of payment is coherent rather than arbitrary —
   the reward and the reason for it are the same fact.
2. **Activity streaks, measured in days, not amount.** Take payments on twenty days in a month
   rather than push twenty payments through one afternoon. This drives the habit that retention
   is actually made of, and wash trading cannot beat it profitably because every fake
   transaction still pays a real fee.
3. **Referral, conditional on both merchants staying active.** A merchant who brings another
   earns a share of that merchant's rebate for a fixed period — but only while both are
   trading. Aligned with retention rather than signup, which is what makes it worth paying for.

### 3 · Two dials, and only one of them saturates

**Stake raises the offline ceiling — and is meant to stop mattering.**

`offline_limit = min(base × (1 + k·√(stake_value)) × reputation, hard_cap)`. Sublinear so trust
cannot simply be bought, weighted by settled volume, dispute rate and tenure so it is not
pay-to-trust, and hard-capped so no merchant creates unbounded exposure.

Past the point where the limit covers their largest realistic basket, more collateral is dead
capital. That is correct behaviour for a collateral system — an over-collateralised merchant is
wasting money — and it is precisely why it cannot be the only thing on offer.

**Earning does not saturate, and the excess comes out.**

Anything staked above what the merchant's current limit actually requires becomes
**withdrawable**, in a window, after the cooldown. If it is never spendable it is not earnings
and the merchant will correctly refuse to treat it as such.

The cooldown itself is not arbitrary: it must exceed the maximum offline settlement window, so
nobody can unstake to escape a pending loss. The delay *is* the settlement horizon, and it is
explainable in one sentence to a shopkeeper.

### 4 · What the stake is doing while it sits there

1. **First-loss capital.** If that merchant is party to a conflicting voucher, their stake
   absorbs the loss before the platform reserve does. This is the honest quid pro quo for the
   higher limit — and it is what makes the premium on the SKR election economically real rather
   than promotional.
2. **Delegated to a Guardian, so it earns.** Risk capital that would otherwise lie idle earns
   the network's own staking yield. Solana Mobile is a Guardian at launch; Helius, Jito, Anza
   and Triton are named partners.
3. **Valued with a haircut, revalued at redemption.** SKR moves. Value the collateral
   conservatively — a 50% haircut to a TWAP — and re-evaluate when a claim is made rather than
   when the stake was posted. A collateral model that pretends its collateral is stable is not a
   collateral model.

> **The merchant-facing version, in one breath**
>
> **Take your rebate in cash, or take more of it in SKR with a bigger offline limit and yield on
> the balance. Trade more days, and trade offline, and you earn more of it. Anything above what
> your limit needs, you can take out.**
>
> Two dials the merchant controls, one thing they choose every month, and an exit. That is an
> incentive. The version where SKR simply appears in an account they cannot touch is not.

### Why this still passes the decorative-versus-structural test

SKR does three jobs: collateral, trust signal, and Guardian delegation. Remove it and the risk
model gets strictly worse — the floor limit has nothing to key off and the reserve must grow.
The incentive layer sits on top of that structure rather than replacing it, which is the
difference between an integration and a sticker. It also uses SKR's *actual designed utility*,
staking and Guardian delegation, rather than inventing a parallel one.

### Anti-gaming, stated up front

- Rebate and bonus accrue only on **settled, non-refunded** volume from distinct counterparties
- Velocity limits and counterparty-concentration checks, so two colluding accounts earn nothing
- Streak credit requires distinct payers per day, not repeated self-payment
- Referral share pauses the moment either merchant goes inactive
- Reputation decays with inactivity, so a dormant stake does not hold a high limit indefinitely

### The disclosure that has to be in the app

A merchant who elects SKR is accepting price risk on a volatile asset in exchange for a premium
and a higher limit. If SKR falls, the rebate they took was worth less than the cash they
declined. Say that in one plain sentence at the point of election — and take advice on whether
the rebate is correctly characterised as a fee rebate in the launch market before any of this
goes live.

---

## 6 · Market

Nelo competes with the POS terminal directly, on the phone the merchant already carries.

| | | Source |
|---|---:|---|
| **Nigeria POS volume** | **₦59.33T a quarter** (~$153B a year at ₦1,550/$) | CBN, Q1 2026 |
| — of which settled through NIBSS | ₦18.78T a quarter (~$48B a year) | NIBSS, Q1 2026 |
| **Active POS terminals** | **5.9M** (8.36M registered) | CBN, Mar 2025 |
| Volume per active terminal | ~$23–71 a day | Derived from the two above |
| Mobile money, Sub-Saharan Africa | $1.4T in 2025, 66% of global value | GSMA |
| Stablecoins on Solana | ~$650B of volume, Feb 2026 | 2026 reporting |
| Merchants preferring stablecoins | 75% of those planning crypto acceptance | Deloitte |

**TAM · SAM · SOM.** $1.4T of mobile money in Sub-Saharan Africa, reachable through UseAzza's
nine-plus payout currencies; **$153B** of Nigerian POS volume, the market Nelo takes on first;
and **$0.9B** of year-one volume from 150,000 businesses.

**Why a phone wins against a terminal.** No hardware to buy, rent or wait for; it takes Solana
Pay from any wallet, nelo pay offline, and transfers a terminal cannot; and it works when the
network does not. That is why the plan sizes distribution against the terminal base itself.

| | |
|---|---|
| **Primary user** | Micro, small and mid-sized merchants with an Android phone: market traders, restaurants, couriers and taxis, field services, fashion and jewellery, supermarkets, hotels and clubs |
| **Secondary** | Their customers — no app needed online; nelo pay for offline payments, transfers and, from month six, savings, bills and cash-out |
| **Wedge** | One trading cluster in Lagos, where card failures are visible and routine |
| **Expansion** | Currency is configuration. A new market is a payout partner and a price feed, not a rebuild |
| **Competition** | Moniepoint, OPay and PalmPay terminals on reach; bank terminals on cost and reliability. Neither takes a payment when the network is down |

## 7 · How it makes money

Four lines, in order of how soon they arrive: a platform fee on settled volume, spread on the
payout conversion, a fee for instant rather than nightly settlement, and later, lending against
observed cashflow — the same sequence Square walked.

### Unit economics

> **Model, not forecast — replace every input with a real number.**

| Assumption | Value | Basis |
|---|---:|---|
| Merchant daily turnover | $95 | Small stall; varies enormously by segment |
| Share captured on Nelo | 40% | Cash keeps the rest early on |
| Platform fee | 0.50% | Below typical card acceptance cost |
| Payout spread | 0.80% | Shared with the disbursement partner |
| Less: insurance reserve | 0.29% | Set by `@nelo/reserve`; 0.20% did not cover expected loss |
| Less: Trust Stake rebate | 0.10% | 20% of the platform fee, bought on market |
| **Net take rate** | **0.91%** | |
| **Net revenue per merchant / month** | **≈ $10** | |
| **At 1,000 merchants** | **≈ $10k / mo** | |
| **At 25,000 merchants** | **≈ $259k / mo** | |

Thin per merchant and entirely normal for acquiring — the business is volume and retention, and
the retention argument is that a merchant who has been paid on an afternoon the bank terminal
was down does not go back. The lending line is where acquiring businesses actually make money,
and it is unlocked by owning the cashflow record, not by charging more.

---

### The three-year model

From [`deck/growth-model.py`](deck/growth-model.py), grounded in the CBN and NIBSS figures above:
500 users in month one at four businesses to every payer, 4,000 by month three, then field
sales and the network effect. 70% of signed businesses trade in a month, at $100 a day each on
Nelo; it costs about $30 to sign a business, paid back in about six weeks.

| | Year 1 | Year 2 | Year 3 |
|---|---:|---:|---:|
| Businesses | 150K | 800K | 2M |
| Share of active POS terminals | 2.5% | 13.6% | 33.9% |
| nelo pay users | 300K | 2.5M | 8M |
| Payment volume | $0.9B | $10.6B | $34.7B |
| Revenue | $8.3M | $102M | $351M |
| Share of Nigeria's POS volume (year end) | 2.5% | 13.3% | 33.4% |

An illustrative model, not a forecast: every input is stated in the script and can be changed.

---

## 8 · Distribution

- **Cluster by cluster, on foot.** Merchants in a market talk to each other constantly; density
  beats reach. A field team signs one row of stalls completely before opening the next market.
  This is doorstep work, and it is also the product research.
- **Four businesses to every payer at launch, then the flywheel.** Every shop brings its
  customers onto nelo pay; every customer asks the next shop "do you take nelo?". Merchant
  acquisition is linear, peer transfer is not.
- **App stores.** Play Store for reach; the Solana dApp Store for customers who already hold
  wallets.
- **The Trust Stake as a retention loop.** A merchant with staked collateral and a raised limit
  has a reason to keep volume on Nelo that has nothing to do with loyalty.
- **Payout partners as a channel.** paj.cash and UseAzza have merchant relationships and an
  interest in volume. The integration that gated the start becomes a distribution partner.

---

## 9 · Stack

| Layer | Choice | Cost |
|---|---|---|
| App | **Expo / React Native** + TypeScript, Android, EAS development build (not Expo Go — the native module cannot run there) | Free |
| Wallet | **Mobile Wallet Adapter** — the Solana Mobile standard; **Privy** embedded so merchants never handle a key | $0 → $299/mo |
| Online sale | **Solana Pay** transaction requests — `@solana/pay`. Works with any wallet the customer has | Free |
| Vault program | **Anchor 1.2.x** — vault PDA, 128-slot replay window, timelocked withdraw, Trust Stake | Deploy gas |
| Signing | **Android StrongBox** P-256 + key attestation, via a Kotlin Expo module | OS-level |
| Verification | **secp256r1 precompile** at `Secp256r1SigVerify111…`, via instruction introspection | Free |
| Settle on reconnect | The till queues vouchers, not signed transactions, and each redemption is signed fresh when sent, so nothing expires and no durable nonce is needed | Free |
| Transport | **react-native-hce** (NFC Type 4), **react-native-ble-plx** fallback, QR at v10 / ECC M | Free, MIT |
| Fee sponsor | **Nelo's own relayer** (`services/relay`) pays offline settlement fees, so a merchant never needs SOL. Kora was the plan; its client is kept, unused | Self-hosted |
| Price feed | **Pyth** or Switchboard, USD → local currency | Free on-chain |
| SKR | Guardian delegation for staked collateral; TWAP for the haircut | Market cost |
| Payout | **paj.cash** (Nigeria, live) and **UseAzza** (9+ currencies, live at launch); a regional partner per new corridor | Commercial |
| Infra | **Helius** RPC · Node + Fastify services · double-entry ledger · managed hosting from launch | ~$70/mo today |
| Publishing | `@solana-mobile/dapp-store-cli` + Publisher Portal; Publisher, App and Release NFTs | Gas only |

### Pinned toolchain

The program side is pinned so a clone reproduces the build exactly. See
[`../README.md`](../README.md) for the install commands.

| Tool | Version | Where it is pinned |
|---|---|---|
| Anchor | 1.2.0 | `Anchor.toml` → `[toolchain] anchor_version` |
| Solana / Agave | 4.2.2 | `Anchor.toml` → `[toolchain] solana_version` |
| Rust (host) | 1.98.1 | `rust-toolchain.toml` |
| `anchor-lang` | 1.2.0 | `programs/nelo_vault/Cargo.toml` |
| TypeScript client | `@anchor-lang/core` 1.2.x | Added to the apps when they need it |

Two things to know, because they will bite otherwise. The pre-1.0 TypeScript client
`@coral-xyz/anchor` is **abandoned at 0.32.1** — the post-1.0 package is `@anchor-lang/core`,
and nothing in this repo may import the old name. And program tests are **Rust + LiteSVM**, not
mocha: `anchor test` builds the `.so` and runs `cargo test`. LiteSVM must be new enough to load
the SBFv3 ELF that Anchor 1.2 emits — 0.16.0 works against Agave 4.2.2; the version the upstream
scaffold ships with (0.10.0) silently fails to load it with `InvalidAccountData`.

---

## 10 · Partnerships

| Partner | Why | Status |
|---|---|---|
| **paj.cash** | Licensed naira payout to any Nigerian bank, ~20 seconds, 24/7, $0.50–$10,000 per payout | **Live** on their production API |
| **UseAzza** | Second payout partner: redundancy in Nigeria and nine-plus more payout currencies | **Live at launch** |
| **Solana Mobile** | dApp Store publishing; the Seeker's secure element and SKR | Publisher account in place |
| **Privy** | Embedded wallets, so a merchant signs up with email or phone and never sees a key | Integrated |
| **A Guardian** | SKR delegation of staked collateral. Solana Mobile is a Guardian at launch; Helius, Jito, Anza and Triton are named partners | To sign |
| **An auditor** | External review of `nelo_vault` before offline payments go to mainnet | Seed use of funds |
| **Merchant associations** | A market association, a landlord, or the trader everyone else copies. One relationship opens fifty conversations | Lagos, at launch |
| **Legal counsel** | Two questions before scale: is the Trust Stake rebate characterised correctly, and how the non-custodial payout flow is classified in each market | Seed use of funds |

---

## 11 · Operating requirements

- **Hosted relayer and settlement service** with a fixed domain, secrets in a manager, and
  alerting on the fee payer's SOL on both clusters.
- **Separate authority keys** for the program upgrade, enrolment and risk, on hardware wallets
  before mainnet.
- **Two RPC providers** per cluster, with failover (`@nelo/rpc`).
- **Google attestation root and CRL** for verifying device enrolment.
- **A device lab**: handsets with and without StrongBox, including the low-cost models the
  market actually uses.
- **Daily reconciliation** of the journal against the chain, and a runbook for failed payouts
  (paj.cash refunds or retries on request, quoting the order id).

---

## 12 · Plan, team and hiring

### Milestones

| Milestone | When | Outcome |
|---|---|---|
| Launch | Q4 2026 | Play Store and dApp Store; paj.cash and UseAzza live; first Lagos cluster; 500 users in month one, 4,000 by month three |
| Production hardening | Q1 2027 | Vault audit; offline payments on mainnet; hosted, monitored infrastructure |
| nelo pay services | From month six | Cash out, savings with yield, bills, stocks and RWAs, an agent payments API |
| Credit and corridors | 2027 | Merchant credit against observed cashflow; new payout currencies |

The detailed record and the next engineering milestones are in [`ROADMAP.md`](ROADMAP.md).

### The founder

**Udoka A.M** ([udokaam.dev](https://udokaam.dev)) — led product end to end at Zinari Finance
(now Yativo) across DeFi, NFTs and payments; regional DevRel at Superteam Nigeria ($40K community
GDP in five months, a Colosseum winner, QuickNode and MagicBlock partnerships); a Solana
Foundation grant for SprintIQ, since sold; 4,000+ developers reached across Africa.

### Who we are hiring first

| Role | What they own |
|---|---|
| **Senior mobile engineer** (React Native + Kotlin) | Both apps, the StrongBox attestation module, NFC, offline queue and device coverage |
| **Protocol engineer** (Rust / Anchor) | `nelo_vault`, the audit, mainnet launch of offline payments, the replay-window and recovery work |
| **Backend / payments engineer** (TypeScript) | The relayer, the settlement service, partner integrations, reconciliation and hosting |
| **Head of merchant growth** (Lagos) | The field team, cluster launches, merchant support and the referral loop |
| **Partnerships and compliance lead** | Payout partners, new corridors, licensing questions and counsel |

### Use of the seed round

Launch in Lagos with a field team; the external audit and mainnet offline payments; the first
five hires above; hosted infrastructure; and the payout reserve that backs the offline guarantee.

---

## 13 · Risks

| Risk | What already mitigates it |
|---|---|
| **Double spend offline** | Offline money is locked in an on-chain vault first; a replayed voucher is refused; a forged second voucher freezes the vault and slashes its SKR stake |
| **A tampered phone** | Keys live in the secure element and never leave it; floor limits cap any loss; the insurance reserve covers the residual |
| **StrongBox is not on every phone** | Capability is detected, never assumed; without it the app degrades to online-only, never to a software key |
| **A payout partner goes down** | Two partners from launch; money waits in the merchant's own wallet until it is paid out |
| **Regulation** | Nelo never holds funds or keys; licensed partners handle naira payout and KYC; counsel before scale |
| **Merchants don't want crypto** | Naira on every screen, no crypto words, no hardware; any Solana wallet pays; cash reaches the bank in seconds |
| **A smart contract bug** | Negative tests before positive ones; 500+ tests in CI; an external audit before offline payments go to mainnet, with low limits until then |
| **Network conditions** | Services resolve IPv4 first and retry failed lookups; the apps time out, retry and say which host they could not reach |

The standing risk is that the offline guarantee is an insurance business Nelo is in whether it
plans for it or not. The floor limit and the reserve are modelled ([`RESERVE.md`](RESERVE.md))
and set from that model, not picked.

---

## Sourcing

Technical claims are from primary documentation: the secp256r1 precompile from SIMD-0075 and
Solana mainnet activation records; StrongBox, key attestation and KeyMint algorithm support from
the Android Open Source Project; QR capacities from ISO/IEC 18004; replay-window handling follows
the standard IPsec anti-replay construction.

Market figures: POS volume and terminal counts from CBN and NIBSS data for Q1 2026 and March
2025, as reported by TechNext24, Nairametrics, BusinessDay and Techpoint; POS failure rates from
2026 Nigerian reporting; mobile money from GSMA; merchant stablecoin preference from Deloitte.

All financial tables are illustrative models with stated assumptions, not forecasts or quotes.
