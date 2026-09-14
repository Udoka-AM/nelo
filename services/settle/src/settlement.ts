/**
 * The money movements, as transactions on the journal.
 *
 * Each function here posts one economic event. They are the only things that
 * write to the ledger, so the set of shapes a transaction can take is finite
 * and readable in one file — which is what makes reconciliation tractable and
 * an audit cheap.
 *
 * Every one takes its idempotency key from the outside world: an on-chain
 * signature, a payout id, a partner reference. Retries are the normal case.
 */
import {
  CUSTODY,
  DISBURSEMENT_PAYABLE,
  forMerchant,
  forPartner,
  INSURANCE_RESERVE,
  PARTNER_RECEIVABLE,
  PAYABLE,
  PAYOUT_SPREAD_REVENUE,
  PLATFORM_FEE_REVENUE,
  REBATE_EXPENSE,
  REBATE_PAYABLE,
  RESERVE_FUNDING_EXPENSE,
} from "./accounts.ts";
import type { Currency, Entry, Ledger, PostResult } from "./ledger.ts";
import { splitPayout, splitSale, type ConversionRate, type PayoutSplit } from "./money.ts";

/** Drops the legs that came out at zero — a 0.1% rebate on a small sale is one. */
const nonZero = (entries: Entry[]): Entry[] => entries.filter((e) => e.amount !== 0n);

export interface SettleSaleInput {
  /** The on-chain signature. Unique, and already the natural id for this event. */
  signature: string;
  merchantId: string;
  /** What actually arrived, in settlement-token minor units. */
  grossMinor: bigint;
  tokenCurrency: Currency;
  at: number;
  rates?: { platformFeeBps?: bigint; reserveBps?: bigint; rebateBps?: bigint };
}

/**
 * A sale has settled on chain.
 *
 * One transaction, not four, because it is one economic event: the money
 * arrived, our fee was earned, the reserve was funded and the rebate accrued,
 * all at the same instant. Splitting it would let three of the four land and
 * the fourth fail.
 */
export function settleSale(ledger: Ledger, input: SettleSaleInput): PostResult {
  const { signature, merchantId, grossMinor, tokenCurrency: currency, at } = input;
  const split = splitSale(grossMinor, input.rates);

  return ledger.post({
    id: `sale:${signature}`,
    at,
    kind: "sale",
    memo: `sale ${signature} for ${merchantId}`,
    entries: nonZero([
      // The money arrived and we hold it.
      { account: CUSTODY, currency, amount: split.gross },
      // Most of it is the merchant's.
      { account: forMerchant(PAYABLE, merchantId), currency, amount: -split.net },
      // The rest is ours.
      { account: PLATFORM_FEE_REVENUE, currency, amount: -split.platformFee },

      // Funded out of our own take, not charged on top.
      { account: RESERVE_FUNDING_EXPENSE, currency, amount: split.reserve },
      { account: INSURANCE_RESERVE, currency, amount: -split.reserve },

      // Accrued now, elected cash-or-SKR later.
      { account: REBATE_EXPENSE, currency, amount: split.rebate },
      { account: forMerchant(REBATE_PAYABLE, merchantId), currency, amount: -split.rebate },
    ]),
  });
}

export interface InstructPayoutInput {
  payoutId: string;
  merchantId: string;
  partner: string;
  /** What leaves the merchant's dollar balance. */
  tokenMinor: bigint;
  tokenCurrency: Currency;
  localCurrency: Currency;
  /** What the partner gives us. */
  partnerRate: ConversionRate;
  /** What we quote the merchant. The gap is the spread. */
  merchantRate: ConversionRate;
  at: number;
}

/** Intersection rather than `extends`: `PostResult` is a union. */
export type InstructedPayout = PostResult & { split: PayoutSplit };

/**
 * A payout has been instructed to the partner.
 *
 * Two currencies in one transaction, balancing separately. The dollar side
 * leaves custody and clears what we owed the merchant; the local side opens a
 * receivable against the partner, records what the merchant will receive, and
 * recognises the spread.
 *
 * The merchant's dollar balance is cleared *here*, not when the partner
 * confirms — the money has genuinely left, and a balance that still shows it
 * would let the same dollars be paid out twice.
 */
export function instructPayout(ledger: Ledger, input: InstructPayoutInput): InstructedPayout {
  const split = splitPayout(input.tokenMinor, input.partnerRate, input.merchantRate);
  const token = input.tokenCurrency;
  const local = input.localCurrency;

  const result = ledger.post({
    id: `payout:${input.payoutId}:instructed`,
    at: input.at,
    kind: "payout.instructed",
    memo: `payout ${input.payoutId} for ${input.merchantId} via ${input.partner}`,
    entries: nonZero([
      // --- the dollar side ---
      // The merchant's dollar claim is discharged and the dollars go to the
      // partner. The two currencies do not balance against each other and are
      // not meant to: the merchant's claim *converts* here, from a dollar one
      // to a local one, which is precisely what a payout is.
      { account: forMerchant(PAYABLE, input.merchantId), currency: token, amount: split.tokenMinor },
      { account: CUSTODY, currency: token, amount: -split.tokenMinor },

      // --- the local side ---
      {
        account: forPartner(PARTNER_RECEIVABLE, input.partner),
        currency: local,
        amount: split.partnerLocalMinor,
      },
      {
        account: forMerchant(DISBURSEMENT_PAYABLE, input.merchantId),
        currency: local,
        amount: -split.merchantLocalMinor,
      },
      { account: PAYOUT_SPREAD_REVENUE, currency: local, amount: -split.spreadLocalMinor },
    ]),
  });

  return { ...result, split };
}

export interface SettlePayoutInput {
  payoutId: string;
  merchantId: string;
  partner: string;
  /** The partner's own reference for the disbursement. */
  partnerReference: string;
  merchantLocalMinor: bigint;
  localCurrency: Currency;
  at: number;
}

/**
 * The partner confirms the money reached the merchant's bank.
 *
 * What remains on the partner receivable afterwards is the spread — real money
 * the partner still owes us, settled on their own remittance cycle. Leaving it
 * visible rather than writing it off at instruction time is the difference
 * between knowing what you are owed and hoping.
 */
export function settlePayout(ledger: Ledger, input: SettlePayoutInput): PostResult {
  const currency = input.localCurrency;
  return ledger.post({
    id: `payout:${input.payoutId}:settled`,
    at: input.at,
    kind: "payout.settled",
    memo: `partner ref ${input.partnerReference}`,
    entries: nonZero([
      {
        account: forMerchant(DISBURSEMENT_PAYABLE, input.merchantId),
        currency,
        amount: input.merchantLocalMinor,
      },
      {
        account: forPartner(PARTNER_RECEIVABLE, input.partner),
        currency,
        amount: -input.merchantLocalMinor,
      },
    ]),
  });
}

export interface FailPayoutInput extends Omit<InstructPayoutInput, "at"> {
  split: PayoutSplit;
  reason: string;
  at: number;
}

/**
 * The payout failed. Put everything back.
 *
 * A reversal, not a deletion: the instruction stays in the journal and this
 * sits after it, so the record shows that it was attempted and why it did not
 * land. The merchant's dollar balance comes back, which is the part they care
 * about — a failed payout that leaves their money in limbo is the single
 * worst outcome this service can produce.
 */
export function failPayout(ledger: Ledger, input: FailPayoutInput): PostResult {
  const { split } = input;
  const token = input.tokenCurrency;
  const local = input.localCurrency;

  return ledger.post({
    id: `payout:${input.payoutId}:failed`,
    at: input.at,
    kind: "payout.failed",
    memo: input.reason,
    entries: nonZero([
      { account: CUSTODY, currency: token, amount: split.tokenMinor },
      {
        account: forMerchant(PAYABLE, input.merchantId),
        currency: token,
        amount: -split.tokenMinor,
      },

      {
        account: forPartner(PARTNER_RECEIVABLE, input.partner),
        currency: local,
        amount: -split.partnerLocalMinor,
      },
      {
        account: forMerchant(DISBURSEMENT_PAYABLE, input.merchantId),
        currency: local,
        amount: split.merchantLocalMinor,
      },
      { account: PAYOUT_SPREAD_REVENUE, currency: local, amount: split.spreadLocalMinor },
    ]),
  });
}

// ------------------------------------------------------- reconciliation ---

export interface Reconciliation {
  /** What the journal says we hold. */
  expectedMinor: bigint;
  /** What the chain says we hold. */
  observedMinor: bigint;
  /** Observed minus expected. Negative means money is missing. */
  driftMinor: bigint;
  balanced: boolean;
}

/**
 * Does the ledger agree with the chain?
 *
 * The one check that catches everything else: a missed sale, a double-posted
 * payout, a sweep nobody recorded. Run it at close of day, and treat any drift
 * at all as an incident — "small" drift is still a transaction you cannot
 * explain.
 */
export function reconcileCustody(
  ledger: Ledger,
  currency: Currency,
  observedMinor: bigint,
): Reconciliation {
  const expectedMinor = ledger.balance(CUSTODY, currency);
  const driftMinor = observedMinor - expectedMinor;
  return { expectedMinor, observedMinor, driftMinor, balanced: driftMinor === 0n };
}

/** What a merchant would be paid if a payout ran right now. */
export function merchantBalance(
  ledger: Ledger,
  merchantId: string,
  currency: Currency,
): bigint {
  return ledger.normalBalance(forMerchant(PAYABLE, merchantId), currency);
}
