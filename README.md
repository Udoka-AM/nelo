# Nelo

Accept payments on the phone you already own. Money lands in your own currency, in your own bank. And it keeps working when the network doesn't.

**Built for CLOCK IN — a Solana Mobile hackathon presented by Radiants.**
Submissions close **8 Oct 2026, 11:59pm PST**. Android APK, Solana Mobile Stack + Mobile
Wallet Adapter, mobile-first, meaningfully interacts with Solana. No website in a wrapper.

📄 **Full build plan:** https://claude.ai/code/artifact/d61c0258-3b7c-43db-ab2f-e89a49f0519d

📊 **Pitch deck:** [`docs/deck/index.html`](docs/deck/index.html) &nbsp;·&nbsp; [hosted](https://claude.ai/code/artifact/ea8d9472-6b93-4129-ba0b-dede30a9bdd4)

---

## Status

Scaffold. Nothing works yet. See the build plan for the four-week sequence and for what
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
```

## Getting started

```bash
pnpm install
cp .env.example .env      # fill in HELIUS_API_KEY
```

## Hard rules for this repo

- **The judges clone this repo and run it.** Keep `pnpm install` → run working at all times.
- **Never commit a keypair, a mnemonic, or a real API key.** `.env` is ignored; keep it that way.
- **Start clean.** Hackathon eligibility requires the project to have started within roughly
  the last three months. Do not import an existing codebase.
- **Publish a stub to the dApp Store in week one** so the pipeline is proven — winners must
  publish within 30 days of winning to claim a prize.

## Licence

UNLICENSED for now — decide before submission. Judges can read a private repo you share
with them; the public licence choice is a launch decision, not a build one.
