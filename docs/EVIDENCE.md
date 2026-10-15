# Evidence: where to verify every claim

For investors, auditors, partners and engineers. Each claim Nelo makes, the code that implements
it, the tests that prove it, and how to run them yourself. [`SECURITY.md`](SECURITY.md) explains
the security model in prose; this page is the index.

## Live today versus roadmap

| | Status | Evidence |
|---|---|---|
| Two Android apps (nelo for business, nelo pay), signed release builds | ✅ Live | APKs built on EAS `production`; [demo video](DEMO.md) on real phones |
| Online payment from any Solana Pay wallet (Solflare shown) | ✅ Live (devnet USDC) | [Demo 0:00](DEMO.md); `packages/pay`, `apps/merchant/App.tsx` |
| Online payment from nelo pay | ✅ Live (devnet USDC) | [Demo 0:15](DEMO.md) |
| Offline payment, both phones with no network, settled on reconnect | ✅ Live on devnet | [Demo 0:58](DEMO.md); `pnpm rehearse`; [devnet redemption](https://explorer.solana.com/tx/5gkSdViA4ThH2v9DyLoP1X4XEdhh48sMrC3WEki5tuZKambZ2QfRsMrsMkPjYR3J5hpp2jkxCLYBozzmgZZ5BdRu?cluster=devnet) |
| Payment above the balance or limit refused | ✅ Live on devnet | [Demo 1:48](DEMO.md); `packages/accept`, `redeem_voucher.rs` |
| Double spend (same sequence twice) refused; forged second voucher freezes the vault | ✅ Proven on devnet and in LiteSVM | `pnpm rehearse`; `programs/nelo_vault/tests/vault.rs` |
| Stake slashed into the reserve on proven fraud | ✅ Proven in LiteSVM; skipped on devnet (stake mint) | `slash.rs`, `vault.rs` |
| Cash-out: mainnet USDC → paj.cash → naira in a Nigerian bank | ✅ Live on **mainnet** | [Demo 2:23](DEMO.md); `pnpm proof` (below) |
| Mobile Wallet Adapter signing, including `solana:mainnet` for cash-outs | ✅ Live | `apps/merchant/src/wallet.ts`, `apps/payer/src/wallet.ts` |
| StrongBox P-256 key generation with attestation | ✅ Ran on a handset | `packages/attest` (Kotlin module) |
| UseAzza payout partner (9+ currencies) | 🟡 Integration nearly ready; live at Play Store launch | Commercial agreement; adapter to follow `services/settle/src/paj/` |
| Attestation chain verified against Google's root | 🔜 Roadmap, before mainnet offline payments | [`SECURITY.md` §3](SECURITY.md) |
| External audit of `nelo_vault`; offline payments on mainnet | 🔜 Roadmap (milestone 6) | [`ROADMAP.md`](ROADMAP.md) |
| Merchant rebates paid in cash or SKR | 🔜 Election built and stored; payout not built | `packages/rebate` |
| nelo pay services (cash out, savings, bills, stocks, agent API) | 🔜 From month 6 | [`BUILD.md`](BUILD.md) §7 |
| Hosted relayer and settlement service | 🔜 Launch milestone | Runs on one host behind a fixed tunnel today |

## Where the code is

| Component | Path | Tests |
|---|---|---|
| Anchor program: vault, `redeem_voucher` (secp256r1 precompile), replay window, timelocked withdrawal, `report_conflict`, Trust Stake, `slash` | `programs/nelo_vault/src/` | 45 LiteSVM integration tests (`tests/vault.rs`), 11 golden-vector tests, 19 Rust unit tests; `anchor test` |
| Android Keystore / StrongBox module (Kotlin) | `packages/attest/android/src/main/java/com/nelo/attest/NeloAttestModule.kt`, `packages/attest/src/` | 12 |
| Mobile Wallet Adapter integration | `apps/merchant/src/wallet.ts`, `apps/payer/src/wallet.ts` | Typechecked; ran on handsets |
| Voucher wire format (202 bytes), shared by phone and chain | `packages/voucher`, `vectors/voucher-v1.json` | 38 |
| The till's offline accept/refuse | `packages/accept` | 27 |
| Payer-side issuing (never signs one sequence twice) | `packages/issue` | 21 |
| Offline settle queue | `packages/queue` | 64 |
| Transaction builders matching the program byte for byte | `packages/redeem` | 46 |
| Relayer: redemption, fees, conflict reports, slash crank, cash-out co-signing | `services/relay` | 68 |
| Settlement: double-entry ledger, cash-out lifecycle, paj.cash v2, signed webhooks | `services/settle` | 89 |
| The phone's side of a cash-out, resumable | `packages/cashout` | 7 |
| Reserve model behind the insurance line | `packages/reserve`, [`RESERVE.md`](RESERVE.md) | 17 |
| Everything else (pay, ledger, onboard, enrol, till, rpc, rebate, ui) | `packages/*` | 206 |

**595 TypeScript tests and the Rust suites, green in CI on every push** (`.github/workflows/ci.yml`:
tests, typechecks, `anchor test` on a clean machine).

## Run it yourself

```bash
pnpm install
anchor test                                                        # the program
pnpm -r --filter "./packages/*" --filter "./services/*" test        # every TypeScript suite
cargo test -p nelo_vault --test devnet -- --ignored --nocapture     # the trust model on real devnet
pnpm rehearse                                                      # the offline flow end to end on devnet
```

## Mainnet cash-out proof

The settlement service keeps a record of every cash-out. On the machine that runs it:

```bash
cd services/settle && pnpm proof
```

prints, for each paid cash-out, the Solscan link for the mainnet USDC transfer, paj.cash's order
id, the USDC sent and naira paid, the time it took, and the bank with all but the last four digits
of the account hidden. Those are the figures on the deck's proof slide.
