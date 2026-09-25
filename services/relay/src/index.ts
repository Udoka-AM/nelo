/**
 * nelo relay — fee sponsorship for offline redemptions.
 *
 * ## What this is for, stated narrowly
 *
 * It is **not** what makes an ordinary sale gasless. In the online path the
 * customer's wallet pays the fee and creates the merchant's token account if
 * needed, so a merchant with zero SOL already completes a sale today. Nothing
 * here is required for that.
 *
 * It is what makes the **offline** redemption gasless. A merchant who has been
 * accepting vouchers all day reconnects holding signed bytes and no SOL, and
 * something has to pay to put them on chain. `redeem_voucher` is built for it:
 *
 * ```rust
 * /// Whoever broadcasts. Usually the merchant on reconnect, or the relayer.
 * pub payer: Signer<'info>,
 * ```
 *
 * The payer is not constrained to be the merchant, and it does not need to be:
 * the voucher names its own payee (`address = voucher.merchant`) and carries a
 * hardware signature over the bytes the chain re-checks. A relayer can submit
 * it and cannot redirect it.
 *
 * ## The shape
 *
 *   `policy.ts`  what may be sponsored, and what it costs. Pure, tested.
 *   `kora.ts`    a client for a Kora node. Not used: the relayer holds its own
 *                fee-payer key (`feePayer.ts`). Kept in case a Kora node is wanted.
 *
 *   `redeem.ts`  submitting a voucher as fee payer, idempotently.
 *   `ledger.ts`  what has been submitted and spent, on disk.
 *   `conflict.ts` reporting a double spend, and slashing the stake behind it.
 *   `server.ts`  the HTTP endpoints the merchant app calls.
 *   `main.ts`    running it.
 */
export { createKora, type Kora, type KoraOptions, type SentTransaction } from "./kora.ts";
export {
  decide,
  ATA_RENT_LAMPORTS,
  SIGNATURE_FEE_LAMPORTS,
  type Decision,
  type Limits,
  type SponsorshipRequest,
  type Spent,
} from "./policy.ts";
export { redeem, type RedeemResponse, type RelayRpc, type RelayConfig } from "./redeem.ts";
export { buildRelay, buildServer, serial, type Relay } from "./server.ts";
export { reportConflict, sweep, type ConflictResponse, type ConflictRpc } from "./conflict.ts";
export { createRelayRpc } from "./rpc.ts";
export { feePayerFromSecret, loadFeePayer, type FeePayer } from "./feePayer.ts";
export { emptyLedger, fileLedger, memoryLedger, type Ledger, type LedgerState } from "./ledger.ts";
