# Nelo

**Every business can now take payments on Solana. Even when the network is down.**

Nelo turns the Android phone a merchant already owns into a payment terminal. Customers pay
with any Solana wallet, or with **nelo pay** — fully offline, on both phones, against money
already locked on chain. The merchant sees naira, cashes out to their own bank in about twenty
seconds, and Nelo never holds their money or their keys.

A quarter of card payments in Nigeria fail on a bad afternoon (29.23% on 15 May 2026). Nigeria
moves about **$153B a year through 5.9M POS terminals**. Nelo takes that market on with no
hardware at all.

| | |
|---|---|
| **Product** | Two Android apps: **nelo for business** (the till) and **nelo pay** (the customer app) |
| **Live** | Signed release builds; mainnet USDC cash-out paid into a Nigerian bank through paj.cash |
| **Offline** | Vouchers signed by the phone's secure element, verified on chain by Solana's secp256r1 precompile (devnet) |
| **Payout partners** | paj.cash (Nigeria, live) and UseAzza (nine-plus currencies, live at launch) |
| **Engineering** | 500+ tests across the program, services and shared packages, in CI on every push |
| **Next** | Play Store and Solana dApp Store launch in Lagos; vault audit; offline payments on mainnet |

**Read next**

- [`docs/BUILD.md`](docs/BUILD.md) — the product and business plan: market, unit economics,
  distribution, partnerships, team, hiring and risks.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — the milestone record so far and the engineering roadmap.
- [`docs/RESERVE.md`](docs/RESERVE.md) — what the offline guarantee costs and how the insurance
  line is set.
- [`docs-site/`](docs-site) — the full documentation: architecture, concepts, reference and
  operations runbooks.
- [`docs/deck/`](docs/deck) — investor deck, growth model and product film script.

---

## How it works

**At the counter, online.** The merchant types an amount in naira. The till shows a Solana Pay
code any wallet can pay, watches the chain, and validates the payment against what was asked —
right payee, right mint, enough money, a transaction that did not fail. Anyone can name a
reference, so finding a transaction is never treated as proof.

**At the counter, offline.** The customer has locked USDC into their own on-chain vault with
nelo pay. With no signal on either phone, the customer scans the till's code; their phone signs
a 202-byte voucher with a P-256 key held in the secure element (Android StrongBox) and shows it
back as a QR. The till verifies it on the spot — signature, enrolled device, revocation list,
floor limit, expiry — and records the sale. When the till reconnects, Nelo's relayer redeems it
on chain and pays the fee. Offline money is prepaid, never an IOU.

**Double spends.** Each vault keeps a 128-slot replay window, so vouchers can redeem out of order
but never twice. A forged second voucher at the same sequence is proof of tampering:
`report_conflict` freezes the vault (merchants holding good vouchers are still paid) and `slash`
moves the payer's staked SKR into the reserve as first-loss capital.

**Cash-out.** The merchant picks a bank and account and sees the holder's name before anything
moves. The settlement service opens a payout order with paj.cash; the relayer builds the USDC
transfer to the order's deposit address and pays its fee; the merchant approves it in their own
wallet on mainnet; the naira lands in their bank. Every step is keyed to the cash-out's id, so a
retry continues where it stopped and nothing is sent twice.

**Trust Stake.** Payers stake SKR to raise their offline limit along a sublinear, hard-capped
curve — `min(base × (1 + k·√stake) × reputation, hard_cap)` — valued at redemption with a haircut.
Merchants can take volume rebates in staked SKR at a premium priced from the reserve model.

## Business model

0.91% net on business volume (0.50% platform fee + 0.80% payout spread, less 0.29% insurance
reserve and 0.10% Trust Stake rebate), plus 0.3–1.5% on nelo pay services from month six. The
three-year model in [`docs/deck/growth-model.py`](docs/deck/growth-model.py) reaches 2M
businesses, a third of Nigeria's active POS base, and $351M of revenue in year three. Every
input is stated and can be changed; it is a model, not a forecast.

## Repository

```
programs/nelo_vault/   Anchor program: vault, voucher redemption via the secp256r1 precompile,
                       replay window, timelocked withdrawal, conflict freeze, Trust Stake, slash
apps/merchant/         nelo for business: the till (Expo, Android). MWA or Privy, Solana Pay,
                       offline scan, settle queue, day-book, cash-out
apps/payer/            nelo pay: StrongBox enrolment, vault, offline vouchers, pay a friend
packages/              Shared, tested logic: voucher (wire format), pay, accept, till, issue,
                       queue, enrol, redeem, cashout, rpc, onboard, ledger, reserve, rebate,
                       ui, attest (Kotlin StrongBox module)
services/relay/        Relayer: redeems vouchers, pays fees, reports double spends, cranks slash,
                       co-signs cash-out transfers on mainnet
services/settle/       Settlement: double-entry ledger, cash-out lifecycle, paj.cash v2
tools/rehearse/        The offline flow end to end on devnet, with the apps' own code
scripts/               Environment setup, local gateway, release configuration
site/                  Landing page
docs-site/             Documentation (Mintlify)
docs/                  Business plan, roadmap, reserve model, deck
```

## Getting started

The toolchain is pinned. `Anchor.toml` pins Anchor and Agave, `rust-toolchain.toml` pins Rust.

| Tool | Version |
|---|---|
| Anchor | 1.2.0 |
| Solana / Agave | 4.2.2 |
| Rust (host) | 1.98.1 |
| Node | 22+ |
| pnpm | 9.15.0 |

```bash
agave-install init 4.2.2              # Solana toolchain
avm install 1.2.0 && avm use 1.2.0    # Anchor
pnpm install                          # JS workspace
cp .env.example .env                  # fill in HELIUS_API_KEY
anchor test                           # builds the program and runs its test suite
```

`anchor test` builds the program and runs the Rust and LiteSVM suites; it passes from a clean
clone. The TypeScript suites and typechecks:

```bash
pnpm -r --filter "./packages/*" --filter "./services/*" test
pnpm exec tsc -p tsconfig.check.json
```

Running the apps against phones, the relayer and the settlement service is covered step by step
in [`docs-site/quickstart.mdx`](docs-site/quickstart.mdx) and the
[operations runbooks](docs-site/operations).

The merchant app's onboarding uses a Privy app ID (`EXPO_PUBLIC_PRIVY_APP_ID`), a public
identifier. A Privy **app secret** belongs on a server and must never reach the app bundle.
Without an app ID the app still runs, with Mobile Wallet Adapter as the only sign-in.

## Deployments

| | |
|---|---|
| `nelo_vault` (devnet) | `29QdPRQC8C5v6C8gMcBqtw9T4RxYyZ1wqThkEj3XJeQx` |
| Upgrade authority | `BX8kSVjmx9Eihd173hdrRW1Ap61AmixQzqjtc3o5DQfu` |
| `RiskConfig` (devnet) | `9JEJkGp3evd8wFAztEyjPLgTaRucThLyDJ5nkwdJg9ry` |
| Cash-out mint (mainnet USDC) | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |

The devnet end-to-end check runs vault funding, redemption with the signature verified by the
precompile on a real validator, a refused double spend and a refused signature over other bytes:

```bash
cargo test -p nelo_vault --test devnet -- --ignored --nocapture
```

> **The program keypair is not in this repo, and must not be.** `target/` is gitignored, so
> `rm -rf target/` destroys `target/deploy/nelo_vault-keypair.json` and `anchor build` silently
> generates a new address. The canonical copy is kept outside the repo; restore from it rather
> than editing `declare_id!`. Before mainnet it moves to a hardware wallet.

Program tests are **Rust + LiteSVM** in `programs/nelo_vault/tests/`; no local validator is
needed. The Anchor TypeScript client is `@anchor-lang/core` (1.x); the pre-1.0
`@coral-xyz/anchor` is abandoned and must not be imported.

## Engineering principles

- **A clean clone builds and passes.** `pnpm install` → `anchor test` green, in CI on every push.
- **Negative tests first** in the program: a check that passes because nothing was checked is
  worse than no check.
- **Say what is proven.** "Built", "tested" and "ran on a handset" are different claims; the
  [status page](docs-site/operations/status.mdx) keeps them apart.
- **No secrets in the repo.** Never commit a keypair, a mnemonic or a real API key. `.env`
  files are gitignored. Every `EXPO_PUBLIC_` value is compiled into the app and is public.
- **Non-custodial by construction.** Nelo never holds a merchant's key or money; the relayer
  pays fees and cannot redirect a payment.

## Join us

Nelo is hiring its first engineers: a senior mobile engineer (React Native + Kotlin), a
protocol engineer (Rust / Anchor), a backend and payments engineer (TypeScript), and a head of
merchant growth in Lagos. The roles and what each owns are in
[`docs/BUILD.md`](docs/BUILD.md#12--plan-team-and-hiring). Contact: [udokaam.dev](https://udokaam.dev).

## Licence

Proprietary. All rights reserved.
