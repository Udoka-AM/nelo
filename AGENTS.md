# AGENTS.md: working on Nelo

Read this first. It is the hand-over for any agent picking the project up, kept current with
`main`. The longer records are [`docs-site/operations/status.mdx`](docs-site/operations/status.mdx)
(the honest ledger: proven, written, stubbed), [`docs/DELIVERABLES.md`](docs/DELIVERABLES.md)
(the build sequence) and [`docs/BUILD.md`](docs/BUILD.md) (why things are the way they are).

## What this is

Nelo is an offline stablecoin payment terminal on Solana, for the Solana Mobile CLOCK IN
hackathon. A merchant's Android phone is the till; it takes payment in naira, priced in USDC.
Online, any Solana Pay wallet pays it. Offline, the customer's **nelo Pay** app signs a voucher
with a StrongBox P-256 key against USDC locked in an on-chain vault; the till checks it offline
and settles it later through Nelo's relayer, which pays the fees.

**Deadline: Thu 8 Oct 2026, 11:59pm PST.** Aim to submit Wed 7 Oct. Graded: signed Android APK,
a video of at most 3 minutes, this repo (`pnpm install` then `anchor test` green), the deck
(`docs/deck/index.html`). Scored 25% each on stickiness/PMF, UX, innovation, presentation.

## Map

| Path | What |
|---|---|
| `programs/nelo_vault` | Anchor program: vault, `redeem_voucher` (secp256r1 precompile), replay window, timelocked withdraw, `report_conflict`, Trust Stake, `slash` |
| `apps/merchant` | The till (Expo, Android only). MWA wallet or Privy, Solana Pay, offline scan, queue, day-book, cash-out |
| `apps/payer` | nelo Pay. StrongBox enrolment, vault, pay offline (vouchers as QR), receive from another customer |
| `packages/*` | Shared logic, each with tests: `voucher` (202-byte wire format), `pay`, `accept`, `till`, `issue`, `queue`, `enrol`, `redeem` (tx builders), `rpc` (failover), `ui` (design system), `attest` (Kotlin StrongBox module), and more |
| `services/relay` | Relayer: submits vouchers, pays fees, reports double spends, cranks slash. Runs on the Mac |
| `services/settle` | Ledger and cash-out through paj.cash. Runs on the Mac |
| `scripts/` | `setup-env.mts` (writes all env files), `gateway.mts` (one local port for both services), `release-env.mts` (app values to EAS) |
| `tools/rehearse` | `pnpm rehearse`: the offline gate end to end on devnet with the apps' own code |
| `site/` | Landing page on GitHub Pages (Vite, GSAP); waitlist on Supabase |
| `docs-site/` | Mintlify docs; `operations/` has the runbooks |

## Commands

```bash
pnpm install
pnpm -r --filter "./packages/*" --filter "./services/*" test     # all TS tests
pnpm exec tsc -p tsconfig.check.json                              # + the three below = CI's typecheck
pnpm exec tsc -p packages/attest/tsconfig.json --noEmit
pnpm --filter @nelo/merchant exec tsc --noEmit
pnpm --filter @nelo/payer exec tsc --noEmit
anchor test                                                       # the graded one; CI runs it
cd apps/merchant && npx expo export --platform android            # proves Metro can bundle the app
```

Before pushing app code, run the four typechecks and an `expo export` of the app you touched:
Metro resolves every import at bundle time, and that has caught failures no test did.

Running against phones (on the user's Mac) is in `docs-site/operations/relay.mdx` and
`release.mdx`. The short version: relayer `:8787`, settlement `:8788`, `pnpm gateway` `:8790`,
`ngrok http 8790 --url=https://<domain>.ngrok-free.app`, then `pnpm setup:env --relay-url … --settle-url …/settle`,
then Metro per app (`--port 8082` for the second).

## Conventions (the user's, and they override defaults)

- **Commit straight to `main`, and push the same commit to `claude/week2-development-progress-2fykje`.**
  No PRs for app, docs or site work. Changes to `programs/` go through a draft PR so CI runs
  `anchor test` before they land.
- **Author every commit as `Udoka_AM <udoka.eth@gmail.com>`. No `Co-Authored-By`, no
  `Claude-Session` or any other AI trailer, no model names** in commits, code or docs.
- Commit messages: a short subject, then what was wrong and what changed, in plain sentences.
- Match the surrounding code: comments explain *why*, tests come with behaviour changes,
  negative tests before positive ones in the program.

## Hard rules

- **Never commit a keypair, a mnemonic or a real API key.** `.env` files are gitignored; keep
  them so. The program keypair is not in this repo and must not be.
- The relayer's fee-payer key, `PAJ_API_KEY`, the paj.cash session file and the Privy **app
  secret** live only on the user's Mac (`~/.config/nelo`, `~/.config/solana/nelo`).
- Every `EXPO_PUBLIC_` value is compiled into the APK and is public. Treat it so.
- Keep `anchor test` green; it is graded.
- Say what is proven and what is not. "Built" and "ran on a handset" are different claims; the
  status page keeps them apart and so should every message.

## Where it stands (5 Oct)

**Proven on devnet:** the trust model, Trust Stake, and the full offline gate through the
apps' own code (`pnpm rehearse`, 26 Sep; slash skipped on devnet, passes locally).

**On handsets (two phones, one with StrongBox, development builds):** the till works online
and Solflare pays it; the payer enrolled with a real StrongBox key and funded a vault; the
offline sale scans both ways and is recorded. **Settling it from the handset has not completed
yet**, only because the till could not reach the relayer from the network in use (blocks
cloudflared's port 7844). The fix is ready: ngrok's fixed domain plus `pnpm gateway`.

**Open, in order:**
1. Settle an offline sale on the handsets through the stable address.
2. paj.cash. The client is `services/settle/src/paj/`, built from their HTTP reference
   (`lib/API_REFERENCE.md` in the `paj_ramp` npm package, v1.5.4) and tested against a fake.
   It follows their off-ramp flow: session by one-time code, bank list, name enquiry, **save
   the bank account**, create the order, the merchant's wallet sends USDC to the order's
   deposit address, status from `GET /pub/transactions/:id` (`INIT`, `PAID`, `COMPLETED`).
   Webhooks are unsigned in their examples and are only a prompt to ask the API. KYC is per
   paj.cash user: Nelo's account is verified once with `pnpm paj:kyc`. docs.paj.cash is
   blocked from the cloud sessions; it may hold details the npm reference does not (the user
   says its register-bank-account page differs). Still open with paj.cash: staging mint,
   failure states, session length, one Nelo account vs per-merchant accounts.
3. Release APKs: `pnpm release:env`, then `build:release` per app. Configured, not yet built.
4. Video (3:00 max) and deck (team names; the "What actually ran" slide). The user has asked
   to leave these until the above is done.

**Declared stubs, not to build now:** rebate payout; the SKR premium (1.5× is a placeholder,
the reserve model supports about 1.001×); NGN price feed (fixed rate until paj.cash's rate is
wired); NFC (QR only); the replay-window gap for never-redeemed vouchers; one-scan nelo Pay
when both phones are online (designed, not built); Privy SMS for Nigeria (dashboard setting).

## Things that have bitten

- A 401 from an RPC used to count as an answer; `@nelo/rpc` now fails over on 401/403.
- Quick tunnels change address on restart, and `cloudflared` needs outbound port 7844.
- Android refuses plain http outside development builds, so a LAN relay address only works in
  dev; release needs https.
- Cloud EAS builds do not see the gitignored `.env`; `pnpm release:env` puts the values on EAS.
- Uninstalling the payer app deletes its StrongBox key and strands its vault. Install over it
  (`adb install -r`).
- This cloud container cannot reach devnet, supabase.co or github.io; verify network behaviour
  on the user's Mac, and say when something was not verifiable here.
