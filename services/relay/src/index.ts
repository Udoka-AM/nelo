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
 *   `kora.ts`    the JSON-RPC client for the node that holds the key.
 *
 * Between them sits a transaction builder, which is **not written**. See below.
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

/**
 * Not built, and named rather than discovered.
 *
 * Turning an accepted voucher into a `redeem_voucher` transaction needs the
 * Anchor client, the secp256r1 precompile instruction at index 0, and the
 * account list — and none of it can be proven without a validator to run it
 * against. It is week 3's work, alongside the offline queue that will feed it.
 *
 * The order it will have to follow is already fixed by the program: the
 * precompile instruction must be **first**, because `redeem_voucher`
 * introspects instruction 0 and asserts it verified *this* device key over
 * *these* bytes. A builder that puts it anywhere else produces a transaction
 * that fails on chain for a reason that reads like a signature problem.
 */
export const TRANSACTION_BUILDER = "not implemented — week 3, with the offline queue" as const;
