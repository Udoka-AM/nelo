# Nelo — build plan

Accept payments on the phone you already own. Money lands in your own currency, in your
own bank. And it keeps working when the network doesn't.

**CLOCK IN · Solana Mobile × Radiants.** Submissions close 8 Oct 2026, 11:59pm PST.
Android · Solana · USDC. Build plan v1, 9 Sep 2026.

Nelo is a payment terminal with no terminal. It is built for the merchant economy — a shop,
a stall, a salon, a driver — but the same primitive works between any two people, so paying
a friend uses the identical rails. Everything the merchant sees is in their own currency.
Nothing in the product says the word *crypto*.

| | |
|---|---|
| **Category** | Payments — stablecoins track, merchants as the primary user |
| **Technical core** | P-256. Secure element signs, the chain verifies. No trusted server in the value path |
| **SKR award** | Targeted. Trust Stake — collateral, not cashback. See §5 |
| **Team** | 4 — Android, Anchor, design, commercial |
| **Run cost** | ~$70/month, plus payout spread and reserve |
| **Hard dependency** | Payout. A licensed disbursement partner. Chase it on day one |

**Contents**

1. [The hackathon](#1--the-hackathon)
2. [What Nelo is](#2--what-nelo-is)
3. [How the money actually moves](#3--how-the-money-actually-moves)
4. [Offline, and why double-spend is closed](#4--offline-and-why-double-spend-is-closed)
5. [The Trust Stake — the SKR integration](#5--the-trust-stake--the-skr-integration)
6. [Market](#6--market)
7. [How it makes money](#7--how-it-makes-money)
8. [Distribution](#8--distribution)
9. [Stack](#9--stack)
10. [Partnerships needed](#10--partnerships-needed)
11. [Provisions](#11--provisions)
12. [Four weeks](#12--four-weeks)
13. [Risks](#13--risks)

---

## 1 · The hackathon

*From the organisers' announcement, 8 Sep 2026.*

### Prize ladder

It is ranked, not flat. **1st $30,000 USDC** plus a Seeker per registered teammate, 2nd
$25,000, 3rd $20,000, 4th $15,000, 5th $10,000, then $5,000 each for 6th–10th. Separately,
**$10,000 in SKR for the best SKR integration** — ten winning teams plus one specialist
award, $135,000 total. The gap between first and sixth is six times the money, so aiming
vaguely at "a win" is the wrong target.

### The scorecard — four categories, 25% each

- **Stickiness & PMF** — does it solve something people care about?
- **User Experience** — is it good to use?
- **Innovation / X-Factor** — does it bring something new?
- **Presentation & Demo** — can you show clearly why it deserves attention?

Read that carefully: **UX and Presentation together are half the score.** On a 30-day build
the instinct is to spend the last week on features. The rubric says spend it on the demo and
the design.

### Beyond the money

Winners receive featured dApp Store placement, marketing and launch support, go-to-market
guidance, and a call with Anatoly Yakovenko. The placement is arguably worth more than the
cheque: it puts the app in front of an audience that already holds wallets and already
understands signing a transaction.

### The particulars

| | |
|---|---|
| **Dates** | Registration and submissions opened 8 Sep, 09:00 PST. **Deadline 8 Oct, 11:59pm PST.** Judging 10 Oct – 8 Nov. Winners announced 10 Nov |
| **Judges** | Anatoly Yakovenko, Mert, Chase, Akshay, Beeman, Ethelsec. Four of six are infrastructure, tooling or security people — technical depth is read, not skimmed |
| **Requirements** | Android only. Ships a working APK. Uses Solana Mobile Stack + Mobile Wallet Adapter. Mobile-first. Meaningfully interacts with Solana. **No "website in a wrapper"** — a PWA does not count |
| **Deliverables** | Working Android APK · demo video, **max 3 minutes** · a GitHub repo that clones and runs · pitch deck |
| **Eligibility** | Project started within roughly the last 3 months. **No VC or angel-backed teams** for the USDC prizes. Existing projects need a major new mobile build. KYC required to win |
| **Post-win** | **Winners must publish to the Solana dApp Store within 30 days** to claim. Do a stub publish in week one so the pipeline is proven |
| **Resources** | solanamobile.com/hackathon is the source of truth — registration, updates, AI coaching and security audits. Radiants Discord for support |

> **Three rules teams will fall foul of**
>
> **Start a clean repo.** The project must have started within roughly the last three months;
> do not lift an existing codebase in. **Check funding before you register.** If any
> teammate's company has raised from a VC or angel, the USDC prizes are off the table — find
> that out now, not after winning. **Plan for the dApp Store deadline.** Publishing within 30
> days of winning is a condition of payment, not a formality.

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

*Targets the $10,000 specialist award.*

Start with what not to do. Across 2,992 corpus submissions, *tokenized rewards* as a stated
solution has produced **zero winners in 39 attempts**. A panel including toly, Mert and
Ethelsec reads a rewards programme as paying for volume, because that is what it is. So the
money has to do a job.

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

The mPOS terminal market is forecast at roughly **$40.7 billion in 2026**, growing fastest in
Asia-Pacific at over 22% CAGR — driven specifically by street vendors and informal retail that
were cash-only until sub-$50 readers arrived. Nelo removes even that $50.

Underneath, the settlement layer is ready. Solana cleared roughly **$650 billion of stablecoin
volume in February 2026** and carries about 35% of global on-chain stablecoin transfers by
count. Sub-Saharan Africa alone moved **$1.4 trillion through mobile money in 2025** — 66% of
global transaction value — across 1.2 billion registered and 347 million active accounts.
Deloitte found 75% of merchants planning crypto acceptance prefer stablecoins to anything
volatile.

The reliability wedge is published rather than assumed. Nigerian POS failure rates run in double
digits daily, averaging around 15% and reaching 25% at peak, with **29.23% recorded on 15 May
2026** — roughly 157,000 declined transactions in a day — and the central bank has mandated dual
routing with automatic failover because the single path keeps breaking. That is one worked
example of a condition that recurs across emerging markets, not a Nigerian peculiarity.

| | |
|---|---|
| **Primary user** | Micro and small merchants with an Android phone who cannot get a bank terminal or resent the one they have |
| **Secondary** | Their customers — no app needed online; the app only for the offline path and for peer transfers |
| **Wedge** | One trading cluster in one city, where card fees are visible and network failure is routine |
| **Expansion** | Currency is configuration. New market = a payout partner and a price feed, not a rebuild |
| **Competition** | Bank terminals on cost and reliability; ZunoPay, GotSOL, Solana POS on concept. The offline path is what makes it a different product |

---

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
| Payout spread | 0.50% | Shared with the disbursement partner |
| Less: insurance reserve | 0.20% | Funds the offline guarantee |
| Less: Trust Stake rebate | 0.10% | 20% of the platform fee, bought on market |
| **Net take rate** | **0.70%** | |
| **Net revenue per merchant / month** | **≈ $8** | |
| **At 1,000 merchants** | **≈ $8k / mo** | |
| **At 25,000 merchants** | **≈ $200k / mo** | |

Thin per merchant and entirely normal for acquiring — the business is volume and retention, and
the retention argument is that a merchant who has been paid on an afternoon the bank terminal
was down does not go back. The lending line is where acquiring businesses actually make money,
and it is unlocked by owning the cashflow record, not by charging more.

---

## 8 · Distribution

### During the hackathon

Fifty merchants in one trading cluster, recruited on foot. This is doorstep work, not marketing,
and it is also the product research — you will learn more from the tenth merchant refusing than
from any amount of design.

### After, in order

- **Cluster by cluster.** Merchants in a market talk to each other constantly; density beats
  reach. Win one row of stalls completely before opening a second city.
- **The dApp Store.** A winning placement puts Nelo in front of users who already hold wallets —
  the customer side of the network, seeded for free.
- **Peer transfer as the spreading agent.** Every customer who pays a merchant offline has the
  app; every one of them can pay a friend. Merchant acquisition is linear, peer transfer is not.
- **The Trust Stake as a retention loop.** A merchant with staked collateral and a raised limit
  has a reason to keep volume on Nelo that has nothing to do with loyalty.
- **Payout partners as a channel.** Disbursement providers have merchant relationships already
  and an interest in volume. The integration that gates you at the start becomes a distribution
  partner later.

---

## 9 · Stack

| Layer | Choice | Cost |
|---|---|---|
| App | **Expo / React Native** + TypeScript, Android, EAS development build (not Expo Go — the native module cannot run there) | Free |
| Wallet | **Mobile Wallet Adapter** — required by the rules; **Privy** embedded so merchants never handle a key | $0 → $299/mo |
| Online sale | **Solana Pay** transaction requests — `@solana/pay`. Works with any wallet the customer has | Free |
| Vault program | **Anchor 1.2.x** — vault PDA, 128-slot replay window, timelocked withdraw, Trust Stake | Deploy gas |
| Signing | **Android StrongBox** P-256 + key attestation, via a Kotlin Expo module | OS-level |
| Verification | **secp256r1 precompile** at `Secp256r1SigVerify111…`, via instruction introspection | Free |
| Durable nonce | Nonce accounts for the settle-on-reconnect path, so a queued transfer never expires | ~0.0015 SOL each |
| Transport | **react-native-hce** (NFC Type 4), **react-native-ble-plx** fallback, QR at v10 / ECC M | Free, MIT |
| Fee sponsor | **Kora** relayer — neither merchant nor customer ever needs SOL | Self-hosted |
| Price feed | **Pyth** or Switchboard, USD → local currency | Free on-chain |
| SKR | Guardian delegation for staked collateral; TWAP for the haircut | Market cost |
| Payout | **Yellow Card** or **Onafriq** in the first corridor; a regional equivalent per new market | Commercial |
| Infra | **Helius** RPC + webhooks · Node/Hono · Postgres double-entry ledger · Redis queue | ~$70/mo |
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

## 10 · Partnerships needed

| Partner | Why | When |
|---|---|---|
| **Disbursement partner** | The one that gates everything. Licensed local payout to bank and mobile money. Yellow Card ($6B+ processed, 35+ countries, 106+ banking partners) and Onafriq (400M+ endpoints, piloting USDC with Circle) in parallel — take whichever answers | Day 1 · blocking |
| **On-ramp, later** | Only needed when customers without USDC must fund. Not required for the hackathon if the demo customer is already funded | Post-hackathon |
| **Solana Mobile** | Publisher Portal account, and the hackathon's own security audit resource. Take the audit — Ethelsec is on the panel and a reviewed vault program is cheap credibility | Week 1 |
| **A Guardian** | For SKR delegation of staked collateral. Solana Mobile itself is a Guardian at launch; Helius, Jito, Anza and Triton are named partners | Week 2 |
| **Merchant cluster** | Not a company — a market association, a landlord, or simply the trader everyone else copies. One relationship gets you fifty conversations | Day 1 |
| **Legal counsel, light** | An hour on two questions: is the Trust Stake rebate characterised correctly, and does automated payout make you a money transmitter in the launch market | Before launch |

---

## 11 · Provisions

*Secure before code.*

- [ ] **Payout sandbox** *(commercial · day one)* — Longest lead time of anything. Send both
      emails before opening an editor.
- [ ] **Three Android devices** *(hardware)* — Two with StrongBox, one without to force an honest
      fallback. Verify per device — StrongBox is not universal and assuming it burns week three.
- [ ] **Google attestation root + CRL** *(backend)* — The enrolment service is meaningless
      without chain validation and a verified boot check.
- [ ] **Three authority keypairs** *(Solana)* — Program authority, enrolment, risk. Separate from
      the start, never one key.
- [ ] **Devnet USDC + Helius keys** *(Solana)* — Two Helius keys — app and relay — so you can see
      which burns credits.
- [ ] **EAS account, development build** *(mobile)* — Expo Go cannot load the attestation module.
      Find that out now, not in week three.
- [ ] **Publisher Portal + funded keypair** *(mobile)* — Publish a stub in week one so the
      pipeline is proven and the 30-day post-win deadline holds no surprises.
- [ ] **One real shop** *(commercial)* — Committed now to trading live in week four. A yes in
      week four is not a yes.

---

## 12 · Four weeks

> **Week one has one job, and it is not UI**
>
> A payer funds a vault on devnet, goes into airplane mode, emits a voucher as a QR, a second
> offline phone verifies it, both reconnect, it redeems — and **a second voucher at the same
> sequence is rejected by the program.** No merchant app, no payout, no NFC. If that works the
> product is real. If it does not, better to know on day seven than day twenty-five.

| Week | Goal | |
|---|---|---|
| **1** | **Prove the trust model** | Vault program, StrongBox signature verifying on chain via the precompile, replay window with out-of-order tests, timelocked withdraw, and a deliberate double-spend that fails |
| **2** | **The ordinary sale** | Merchant app, Solana Pay, local-currency display, day-book. Payout sandbox wired. Trust Stake staking and the floor-limit curve |
| **3** | **Offline in the hand** | NFC and QR transport, cached enrolment and revocation lists, offline queue, conflict handling, close-of-day reconciliation. Peer-to-peer transfer falls out of the same code. Full design pass |
| **4** | **Real trading and the film** | A week of live sales in one shop. Signed APK, dApp Store publish, repo that clones and runs, 3-minute video with a shopkeeper in it rather than a developer |

### Team

**Android / Kotlin — the secure element**
- StrongBox P-256 keygen with attestation challenge
- DER → raw r‖s conversion with low-S normalisation
- NFC host card emulation and BLE fallback
- Capability detection and honest degradation

**Rust / Anchor — the vault**
- Precompile introspection — assert ix 0 verified the right key and bytes
- Replay window: set, reject-if-set, advance base
- Trust Stake, floor-limit curve, Guardian delegation
- A negative test that must fail before any positive one passes

**Design — not optional**
- UX is 25% of the score and a POS is where crypto apps look worst
- Day-book and close-of-day are the screens a merchant actually lives in
- The 3-minute video is a design deliverable, not an afterthought

**Commercial — unblock and prove**
- Payout partner sandbox in week one
- A committed shop by week two
- Reserve and floor-limit model before week three

---

## 13 · Risks

### Things that will go wrong

- **Signature encoding.** Android returns DER; the precompile wants raw r‖s, 64 bytes, likely
  low-S normalised. Half a day, spent in week one where it is cheap.
- **StrongBox is not everywhere.** Budget hardware often has a TEE but no discrete secure
  element — and budget hardware is this market. Detect and degrade to online-only. Silently
  falling back to a software key would keep the demo working while destroying the entire
  argument.
- **Precompile introspection is fiddly.** Get the offsets wrong and it appears to work while
  verifying nothing. Write the negative test first: a valid signature over *different* bytes must
  be rejected.
- **The payout partner may not answer.** Decide by end of week one: stub the settlement leg and
  declare it, or pivot the demo to merchant-to-merchant settlement in USDC. Do not spend week
  three hoping.

The standing risk is that the offline guarantee is an insurance business you are entering
whether you plan for it or not — model the floor limit and the reserve before you ship, not
after. And the POS concept is the most contested idea on the shortlist; the win is on payout
experience and reliability, never on the idea itself.

---

## Sourcing

Hackathon rules, prizes, judges, scorecard, deliverables, eligibility and dates are from the
Radiants announcement of 8 September 2026. The organisers name solanamobile.com/hackathon as the
source of truth — re-check against it before committing, since the announcement is a summary.

Technical claims are from primary documentation: the secp256r1 precompile from SIMD-0075 and
Solana mainnet activation records; StrongBox, key attestation and KeyMint algorithm support from
the Android Open Source Project; Subscriptions & Allowances from the Solana Foundation; C2PA from
the Coalition for Content Provenance and Authenticity; QR capacities from ISO/IEC 18004;
replay-window handling follows the standard IPsec anti-replay construction.

Market figures are from 2026 reporting and industry sources cited in the shortlist document.
Crowding reads come from the Colosseum corpus, which ends at Cypherpunk (September 2025) and
cannot see 2026 projects — treat every density read as a floor, not a guarantee.

All financial tables are illustrative models with stated assumptions, not forecasts or quotes.
Every input needs replacing with a real number before it informs a decision. Pricing shown is
2026 list pricing and moves; anything marked commercial has no public rate card.
