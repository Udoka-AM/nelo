# AGENTS.md: working on Nelo

Read this first. It is the hand-over for any engineer or agent picking the project up, kept
current with `main`. The longer records are [`docs-site/operations/status.mdx`](docs-site/operations/status.mdx)
(the honest ledger: proven, written, stubbed), [`docs/ROADMAP.md`](docs/ROADMAP.md) (milestones
done and next) and [`docs/BUILD.md`](docs/BUILD.md) (the product and business plan: why things
are the way they are).

## What this is

Nelo is a payments company: a phone-based payment terminal on Solana, launching in Lagos. A
merchant's Android phone is the till (**nelo for business**); it takes payment in naira, priced
in USDC. Online, any Solana Pay wallet pays it. Offline, the customer's **nelo pay** app signs a
voucher with a StrongBox P-256 key against USDC locked in an on-chain vault; the till checks it
offline and settles it later through Nelo's relayer, which pays the fees. Merchants cash out to
their own bank through paj.cash (live) and UseAzza (live at launch).

## Map

| Path | What |
|---|---|
| `programs/nelo_vault` | Anchor program: vault, `redeem_voucher` (secp256r1 precompile), replay window, timelocked withdraw, `report_conflict`, Trust Stake, `slash` |
| `apps/merchant` | The till (Expo, Android only). MWA wallet or Privy, Solana Pay, offline scan, queue, day-book, cash-out |
| `apps/payer` | nelo Pay. StrongBox enrolment, vault, pay offline (vouchers as QR), receive from another customer |
| `packages/*` | Shared logic, each with tests: `voucher` (202-byte wire format), `pay`, `accept`, `till`, `issue`, `queue`, `enrol`, `redeem` (tx builders), `rpc` (failover), `ui` (design system), `attest` (Kotlin StrongBox module), and more |
| `services/relay` | Relayer: submits vouchers, pays fees, reports double spends, cranks slash, co-signs cash-out transfers. Runs on one host behind a tunnel today |
| `services/settle` | Ledger and cash-out through paj.cash. Runs alongside the relayer |
| `scripts/` | `setup-env.mts` (writes all env files), `gateway.mts` (one local port for both services), `release-env.mts` (app values to EAS) |
| `tools/rehearse` | `pnpm rehearse`: the offline flow end to end on devnet with the apps' own code |
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
anchor test                                                       # the program suite; CI runs it
cd apps/merchant && npx expo export --platform android            # proves Metro can bundle the app
```

Before pushing app code, run the four typechecks and an `expo export` of the app you touched:
Metro resolves every import at bundle time, and that has caught failures no test did.

Running against phones (services on a local machine behind a tunnel) is in `docs-site/operations/relay.mdx` and
`release.mdx`. The short version: relayer `:8787`, settlement `:8788`, `pnpm gateway` `:8790`,
`ngrok http 8790 --url=https://<domain>.ngrok-free.app`, then `pnpm setup:env --relay-url … --settle-url …/settle`,
then Metro per app (`--port 8082` for the second).

## Conventions (the founder's, and they override defaults)

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
- The relayer's fee-payer key, `PAJ_API_KEY`, `PAJ_WEBHOOK_SECRET` (`whsec_…`) and the Privy
  **app secret** live only on the operator's machine (`~/.config/nelo`, `~/.config/solana/nelo`),
  and in a secrets manager once the services are hosted.
- **Cash-outs move real money.** paj.cash has no staging: a cash-out is mainnet USDC. Offline
  payments, vaults and redemptions stay on devnet. Never point a test at paj.cash's API.
- Every `EXPO_PUBLIC_` value is compiled into the APK and is public. Treat it so.
- Keep `anchor test` green; a clean clone must pass it, and CI checks every push.
- Say what is proven and what is not. "Built" and "ran on a handset" are different claims; the
  status page keeps them apart and so should every message.

## Where it stands (13 Oct)

**Live:** signed release APKs of both apps (EAS `production`); a mainnet USDC cash-out paid into
a Nigerian bank through paj.cash's production API; cash-outs have no daily cap by default.

**Proven on devnet:** the trust model, Trust Stake, and the full offline flow through the apps'
own code (`pnpm rehearse`; slash skipped on devnet, passes locally). On handsets the offline sale
scans both ways and is recorded; settling it needs the fee payer funded on devnet (it is).

**How cash-outs run** (paj.cash v2, `services/settle/src/paj/`, https://docs.paj.cash):
- `x-api-key` only; production only, mainnet USDC `EPjF…Dt1v`. Limits $0.50–$10,000 per payout,
  ~20 s, 24/7. `ERROR` is refunded or retried by paj.cash on request (quote the order id).
- Flow: bank list → name enquiry (`POST /pub/v2/bank-account`) → order (`POST /pub/v2/offramp`,
  one-off deposit address) → the relayer builds the USDC transfer, signs as fee payer first and
  sets its own priority fee → the merchant's wallet signs on `solana:mainnet` → status from
  `GET /pub/v2/transaction/:id`. The relayer opens the deposit address's token account if missing.
- Webhooks are HMAC-signed and only prompt a lookup; `pnpm paj:webhook` registers the URL and
  saves the `whsec_` secret.
- Offline payments, vaults and redemptions stay on devnet until the vault audit.

**Next (see `docs/ROADMAP.md`):** Play Store and dApp Store launch with UseAzza live; hosted
relayer and settlement service; the till's lookup-retry fix in the next release build; the vault
audit and offline payments on mainnet.

**Declared stubs, not to build yet:** rebate payout; the SKR premium (1.5× is a placeholder, the
reserve model supports about 1.001×); NGN price feed (the till shows paj.cash's rate when the
settlement service answers, else a fixed rate); NFC (QR only); the replay-window gap for
never-redeemed vouchers; Privy SMS for Nigeria (dashboard setting).

## Things that have bitten

- A 401 from an RPC used to count as an answer; `@nelo/rpc` now fails over on 401/403.
- Quick tunnels change address on restart, and `cloudflared` needs outbound port 7844.
- Android refuses plain http outside development builds, so a LAN relay address only works in
  dev; release needs https.
- Cloud EAS builds do not see the gitignored `.env`; `pnpm release:env` puts the values on EAS.
- Uninstalling the payer app deletes its StrongBox key and strands its vault. Install over it
  (`adb install -r`).
- Cloud agent containers may not reach devnet, supabase.co or github.io; verify network
  behaviour on a real machine, and say when something was not verifiable.
- A phone that cannot resolve the tunnel's host fails with `UnknownHostException`; that is the
  phone's network (Wi-Fi, private DNS), not the services.
