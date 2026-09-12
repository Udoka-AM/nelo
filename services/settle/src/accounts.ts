/**
 * The chart of accounts.
 *
 * Declared, not inferred. A ledger that opens an account whenever it sees a new
 * string will happily balance a typo against itself and report a clean trial
 * balance while the money is in the wrong place.
 *
 * Sub-accounts are per-merchant or per-partner and inherit their parent's type:
 * `liabilities:payable:m1` is a liability because `liabilities:payable` is.
 */
import type { AccountType } from "./ledger.ts";

/** USDC the platform holds on merchants' behalf. */
export const CUSTODY = "assets:custody";
/** Owed to us by a disbursement partner, in local currency. */
export const PARTNER_RECEIVABLE = "assets:partner_receivable";
/** What we owe a merchant, in dollars, before payout. */
export const PAYABLE = "liabilities:payable";
/** What we owe a merchant in local currency, once a payout is instructed. */
export const DISBURSEMENT_PAYABLE = "liabilities:disbursement_payable";
/** Accrued rebate, payable in cash or SKR at the merchant's election. */
export const REBATE_PAYABLE = "liabilities:rebate_payable";
/** Set aside against the offline guarantee. */
export const INSURANCE_RESERVE = "liabilities:insurance_reserve";

export const PLATFORM_FEE_REVENUE = "revenue:platform_fee";
export const PAYOUT_SPREAD_REVENUE = "revenue:payout_spread";

export const REBATE_EXPENSE = "expense:rebate";
export const RESERVE_FUNDING_EXPENSE = "expense:reserve_funding";

export const CHART: ReadonlyMap<string, AccountType> = new Map<string, AccountType>([
  [CUSTODY, "asset"],
  [PARTNER_RECEIVABLE, "asset"],

  [PAYABLE, "liability"],
  [DISBURSEMENT_PAYABLE, "liability"],
  [REBATE_PAYABLE, "liability"],
  [INSURANCE_RESERVE, "liability"],

  [PLATFORM_FEE_REVENUE, "revenue"],
  [PAYOUT_SPREAD_REVENUE, "revenue"],

  [REBATE_EXPENSE, "expense"],
  [RESERVE_FUNDING_EXPENSE, "expense"],
]);

export const forMerchant = (base: string, merchantId: string): string =>
  `${base}:${merchantId}`;
export const forPartner = (base: string, partner: string): string => `${base}:${partner}`;
