# Nelo

Accept payments on the phone you already own. Money lands in your own currency, in your own bank. And it keeps working when the network doesn't.

**Built for CLOCK IN — a Solana Mobile hackathon presented by Radiants.**
Submissions close **8 Oct 2026, 11:59pm PST**. Android APK, Solana Mobile Stack + Mobile
Wallet Adapter, mobile-first, meaningfully interacts with Solana. No website in a wrapper.

📄 **Full build plan:** [`docs/BUILD.md`](docs/BUILD.md) — the hackathon rules and scorecard,
market, unit economics, stack, partnerships, provisions, the four-week sequence and the risks.

📊 **Pitch deck:** [`docs/deck/index.html`](docs/deck/index.html) — a single self-contained
file. Open it in any browser; no build and no server.

---

## Status

Scaffold. The vault program is a stub and the TypeScript packages throw `TODO`. What does
work is the toolchain: `anchor test` builds the program and runs the Rust test suite green.
See [the build plan](docs/BUILD.md#12--four-weeks) for the four-week sequence and for what
week one has to prove before anything else is worth writing.

## Layout

```
programs/nelo_vault/     Anchor program — vault, replay window, Trust Stake
apps/merchant/           Expo — the terminal
apps/payer/              Expo — vault + offline voucher emitter
packages/voucher/        202-byte wire format: encode, decode, verify
packages/attest/         Expo native module — StrongBox P-256 + attestation
services/relay/          Broadcast queue, retry, multi-RPC failover
services/settle/         Double-entry ledger + payout partner
docs/BUILD.md            The build plan
docs/deck/               The pitch deck
```

## Getting started

The toolchain is pinned. These are the versions the repo is built and tested against —
`Anchor.toml` pins the first two, `rust-toolchain.toml` the third.

| Tool | Version |
|---|---|
| Anchor | 1.2.0 |
| Solana / Agave | 4.2.2 |
| Rust (host) | 1.98.1 |
| Node | 22+ |
| pnpm | 9.15.0 |

```bash
# Solana toolchain
agave-install init 4.2.2

# Anchor toolchain
avm install 1.2.0 && avm use 1.2.0

# JS workspace
pnpm install
cp .env.example .env      # fill in HELIUS_API_KEY
```

Then:

```bash
anchor test
```

That builds the program and runs the Rust test suite. It should pass from a clean clone.

## Program tests

Program tests are **Rust + LiteSVM**, in `programs/nelo_vault/tests/`. There is no
mocha/TypeScript test path — `Anchor.toml` sets `[scripts] test = "cargo test"`, and no
local validator is needed.

Anchor's TypeScript client is `@anchor-lang/core` (1.x). The pre-1.0 `@coral-xyz/anchor`
package is abandoned at 0.32.1 — **do not import it.**

## Hard rules for this repo

- **The judges clone this repo and run it.** Keep `pnpm install` → `anchor test` working at
  all times.
- **Everything a judge needs is in the repo.** No pointers to links only the team can open.
  If a document matters, it lives in `docs/`.
- **Never commit a keypair, a mnemonic, or a real API key.** `.env` is ignored; keep it that way.
- **Start clean.** Hackathon eligibility requires the project to have started within roughly
  the last three months. Do not import an existing codebase.
- **Publish a stub to the dApp Store in week one** so the pipeline is proven — winners must
  publish within 30 days of winning to claim a prize.

## Licence

UNLICENSED for now — decide before submission. Judges can read a private repo you share
with them; the public licence choice is a launch decision, not a build one.
