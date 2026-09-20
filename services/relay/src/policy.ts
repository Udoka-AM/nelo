/**
 * What the relayer will and will not pay for.
 *
 * A fee sponsor is a signer that spends its own money on someone else's
 * transaction. The whole design question is: **what stops it being drained?**
 *
 * ## The exposure is rent, not fees
 *
 * The obvious answer — "a signature costs 5,000 lamports, cap the rate" — is
 * the wrong shape for this program. `RedeemVoucher` declares:
 *
 * ```rust
 * #[account(init_if_needed, payer = payer, associated_token::authority = merchant, ...)]
 * pub merchant_token: InterfaceAccount<'info, TokenAccount>,
 * ```
 *
 * So whoever pays the fee also funds the merchant's token account when it does
 * not exist — and that is **rent**, not a fee. A token account is 165 bytes,
 * which at Solana's rent parameters is 2,039,280 lamports: over four hundred
 * times a signature.
 *
 * That is correct on chain — a merchant taking their first Nelo payment must
 * not have the sale fail because they have never held USDC. It is also the
 * thing an attacker reaches for first, because each request they craft costs
 * the relayer four hundred ordinary redemptions.
 *
 * **And Kora's own limits do not see it.** Its `max_allowed_lamports` is
 * enforced against `calculate_fee_payer_outflow`, which sums the fee payer's
 * outflow from the *transaction's own* instruction list — `SystemTransfer`,
 * `SystemCreateAccount`, `SystemWithdrawNonceAccount`. The token account here
 * is created by a CPI from inside `redeem_voucher`, so it never appears in
 * that list. (Kora's Jito bundle path measures outflow by simulation and would
 * catch it; the plain `signAndSendTransaction` path does not.)
 *
 * So the most expensive thing the relayer can be asked to do is the one thing
 * the node cannot bound, which is why this module exists rather than the
 * config being enough. It prices the two cases separately and refuses to fund
 * a new account by default.
 *
 * ## Refuse before spending, not after
 *
 * The signature check runs here, off chain, before a lamport moves. An expired
 * or forged voucher submitted on chain still costs the relayer the fee for a
 * transaction the program will reject. `@nelo/voucher` can answer both
 * questions with no network, so it does.
 *
 * ## Why this is the only sponsorable instruction
 *
 * `redeem_voucher` is the only instruction in the program whose sole signer is
 * an unconstrained `payer`. Every other one — deposit, withdraw, stake,
 * unstake, the risk-config calls — requires the vault owner or the risk
 * authority to sign, so a relayer cannot submit them alone and there is
 * nothing to decide about them.
 */
import { decode, verify, type Voucher } from "@nelo/voucher";

// Solana's rent, from its own parameters rather than a copied constant:
//   (ACCOUNT_STORAGE_OVERHEAD + bytes) × lamports_per_byte_year × exemption_threshold
const ACCOUNT_STORAGE_OVERHEAD = 128;
const LAMPORTS_PER_BYTE_YEAR = 3_480;
const EXEMPTION_THRESHOLD = 2;
/** SPL token account: mint(32) ‖ owner(32) ‖ amount(8) ‖ … */
const TOKEN_ACCOUNT_LEN = 165;

/** 2,039,280 lamports. Derived, so it cannot drift from the formula above. */
export const ATA_RENT_LAMPORTS =
  (ACCOUNT_STORAGE_OVERHEAD + TOKEN_ACCOUNT_LEN) * LAMPORTS_PER_BYTE_YEAR * EXEMPTION_THRESHOLD;

/** One signature, at the base fee. The relayer is the only signer. */
export const SIGNATURE_FEE_LAMPORTS = 5_000;

export interface SponsorshipRequest {
  /**
   * The 202 bytes as they arrived, undecoded.
   *
   * Deliberately not a decoded `Voucher`. `decode` is the only thing that
   * enforces the length and the version, so taking bytes here means a
   * malformed packet is a *refusal with a reason* rather than an exception —
   * and means this module cannot be handed a hand-built object that never
   * passed the decoder at all.
   */
  voucherBytes: Uint8Array;
  /**
   * Whether the merchant's associated token account already exists.
   *
   * The caller reads this from the chain. It is the single input that decides
   * whether this request costs a fee or four hundred of them.
   */
  merchantTokenExists: boolean;
  /** The mint the vault is enrolled for, base58. */
  mint: string;
}

export interface Limits {
  /** Lamports the relayer may spend in the current window. */
  budgetLamports: number;
  /** Redemptions already sponsored, and the ceiling, for this vault. */
  maxPerVault: number;
  /** Mints worth sponsoring. Anything else is someone else's token. */
  allowedMints: readonly string[];
  /**
   * Fund a token account for a merchant who has never been paid?
   *
   * Off by default. On, it is the single most expensive thing the relayer
   * does, and it should be gated on the merchant being known — enrolment, not
   * this module, is where that belongs.
   */
  sponsorNewAccounts: boolean;
}

export interface Spent {
  /** Lamports already spent in the current window. */
  lamports: number;
  /** Redemptions already sponsored for this vault in the current window. */
  forThisVault: number;
}

export type Decision =
  | { sponsor: true; costLamports: number; createsAccount: boolean; voucher: Voucher }
  | { sponsor: false; reason: string };

/**
 * Decide, and say why not.
 *
 * Total, and reads no clock — `nowSeconds` is passed in, as everywhere else in
 * this repo, so expiry is deterministic under test.
 */
export function decide(
  request: SponsorshipRequest,
  limits: Limits,
  spent: Spent,
  nowSeconds: number,
): Decision {
  // Length and version are the decoder's to enforce, and it is the only thing
  // that does. Anything it refuses never reaches the checks below.
  let voucher: Voucher;
  try {
    voucher = decode(request.voucherBytes);
  } catch (e) {
    return { sponsor: false, reason: e instanceof Error ? e.message : "voucher did not decode" };
  }

  // Cheapest checks first, and all of them before any lamport moves.
  if (voucher.expiresAt <= BigInt(nowSeconds)) {
    // The program would reject it. Submitting anyway spends a fee to be told so.
    return { sponsor: false, reason: "voucher has expired" };
  }

  if (voucher.amount <= 0n) {
    return { sponsor: false, reason: "voucher carries no amount" };
  }

  if (!limits.allowedMints.includes(request.mint)) {
    return { sponsor: false, reason: `mint ${request.mint} is not sponsored` };
  }

  // The expensive check, and the one that actually decides whether this is a
  // real redemption or a crafted one. Last of the cheap refusals, first of the
  // ones that cost anything to establish.
  if (!verify(voucher)) {
    return { sponsor: false, reason: "voucher signature does not verify" };
  }

  if (spent.forThisVault >= limits.maxPerVault) {
    return { sponsor: false, reason: "this vault has reached its sponsorship limit" };
  }

  const createsAccount = !request.merchantTokenExists;
  if (createsAccount && !limits.sponsorNewAccounts) {
    return {
      sponsor: false,
      reason: "the merchant has no token account, and funding one is not sponsored",
    };
  }

  const costLamports = SIGNATURE_FEE_LAMPORTS + (createsAccount ? ATA_RENT_LAMPORTS : 0);
  if (spent.lamports + costLamports > limits.budgetLamports) {
    return { sponsor: false, reason: "the relayer's budget for this window is spent" };
  }

  return { sponsor: true, costLamports, createsAccount, voucher };
}
