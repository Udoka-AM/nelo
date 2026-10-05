/**
 * paj.cash as a payout partner, on their v2 API.
 *
 * paj.cash is not paid out of funds it already holds. An offramp order gives a
 * one-off deposit address, and paj.cash pays the bank once the tokens arrive
 * there. So `disburse` returns `funding`: what to send, and where. Sending it
 * is the merchant's wallet's job, with Nelo's relayer paying the fee.
 *
 * ## Why orders, and not the standing bank-account address
 *
 * v2 can also give each bank account a permanent address that pays out
 * whatever lands on it. It is simpler, but paj.cash sends no webhook and keeps
 * no record we can read for those deposits (confirmed 5 Oct), so the till
 * could never tell a merchant their naira arrived. An order has an id, a
 * status, a signed webhook and a record: that is what a cash-out needs.
 *
 * ## What paj.cash told us, and where it lives in code
 *
 *   - No staging: every order is real, in mainnet USDC. `fidelity` is "live".
 *   - $0.50 to $10,000 per payout: `PAJ_LIMITS`, checked before an order.
 *     Below the minimum, the money only comes back by a manual refund.
 *   - A failed payout (`ERROR`) is refunded or retried by paj.cash on request:
 *     the failure says so, with the order id to quote.
 *   - Banks are named by paj.cash's own code, NIBSS today with CBN 3-digit
 *     codes coming. The code is looked up in their list as stored; a code the
 *     list no longer has is refused with a reason, never guessed.
 *   - Nelo's fee (`businessUSDCFee`) is added on top by paj.cash.
 *   - Payouts take about 20 seconds and run 24/7.
 */
import { parseCanonical } from "@nelo/onboard";
import type { ConversionRate } from "../money.ts";
import type { DisburseRequest, DisburseResult, Fidelity, PayoutPartner, PayoutQuote } from "../partner.ts";
import { PajError, type PajBank, type PajBankAccount, type PajClient } from "./client.ts";
import { rateToConversion } from "./decimal.ts";

export type CashoutState = "awaiting-funds" | "processing" | "paid" | "failed";

export interface PartnerStatus {
  /** Null: nothing new, keep what is known. */
  state: CashoutState | null;
  detail: string;
}

/** paj.cash's limits per payout, in USDC base units (6 decimals). */
export const PAJ_LIMITS = { minTokenMinor: 500_000n, maxTokenMinor: 10_000_000_000n } as const;

export interface PajPartnerOptions {
  client: PajClient;
  mint: string;
  tokenDecimals: number;
  localCurrency: string;
  localDigits: number;
  /** Where paj.cash posts this order's updates. Omitted: the key's own ramp webhook. */
  webhookURL?: string;
  /** Nelo's fee on each payout, token base units. Added on top by paj.cash. */
  businessFeeMinor?: bigint;
  /** How long a quote is good for. Default one minute. */
  quoteTtlMs?: number;
  /** How long the bank list is reused. Default an hour. */
  banksTtlMs?: number;
  now?: () => number;
}

export class PajPartner implements PayoutPartner {
  readonly name = "paj";
  /** No staging exists: everything this partner does moves real money. */
  readonly fidelity: Fidelity = "live";
  readonly #o: PajPartnerOptions;
  #banks: { at: number; list: PajBank[] } | null = null;

  constructor(options: PajPartnerOptions) {
    this.#o = options;
  }

  #now() {
    return (this.#o.now ?? Date.now)();
  }

  async rate(): Promise<{ rate: number; conversion: ConversionRate }> {
    const r = await this.#o.client.offrampRate(this.#o.localCurrency);
    if (r.currency !== this.#o.localCurrency) {
      throw new PajError(`paj.cash quotes ${r.currency}, not ${this.#o.localCurrency}`, 502);
    }
    return { rate: r.rate, conversion: rateToConversion(r.rate, this.#o.localDigits, this.#o.tokenDecimals) };
  }

  async quote(tokenCurrency: string, localCurrency: string, now: number): Promise<PayoutQuote> {
    if (localCurrency !== this.#o.localCurrency) throw new Error(`configured for ${this.#o.localCurrency}, not ${localCurrency}`);
    const { conversion } = await this.rate();
    return {
      partner: this.name,
      fidelity: this.fidelity,
      tokenCurrency,
      localCurrency,
      partnerRate: conversion,
      expiresAt: now + (this.#o.quoteTtlMs ?? 60_000),
    };
  }

  /** Nigerian banks paj.cash pays, cached: the list changes a few times a year. */
  async banks(): Promise<PajBank[]> {
    const ttl = this.#o.banksTtlMs ?? 3_600_000;
    if (this.#banks && this.#now() - this.#banks.at < ttl) return this.#banks.list;
    const list = (await this.#o.client.banks("NG")).filter((b) => !b.country || b.country === "NG");
    this.#banks = { at: this.#now(), list };
    return list;
  }

  async bankFor(code: string): Promise<PajBank | null> {
    return (await this.banks()).find((b) => b.code === code) ?? null;
  }

  /**
   * Whose account this is, from the bank. In v2 this is registration: slow (a
   * live bank call) and idempotent, and it leaves the account registered
   * ahead of the cash-out. Null when paj.cash does not list the bank.
   */
  async resolve(code: string, accountNumber: string): Promise<{ accountName: string; bank: PajBank; registered: PajBankAccount } | null> {
    const bank = await this.bankFor(code);
    if (!bank) return null;
    const registered = await this.#o.client.registerAccount(bank.code, accountNumber);
    return { accountName: registered.accountName, bank, registered };
  }

  async disburse(request: DisburseRequest): Promise<DisburseResult> {
    const refuse = (reason: string): DisburseResult => ({ status: "rejected", partner: this.name, fidelity: this.fidelity, reason });
    const parsed = parseCanonical(request.destination);
    if (!parsed.ok) return refuse(parsed.reason);
    if (parsed.destination.method !== "bank") return refuse("paj.cash pays bank accounts, not mobile money");
    if (request.localCurrency !== this.#o.localCurrency) return refuse(`configured for ${this.#o.localCurrency}`);
    if (request.tokenMinor < PAJ_LIMITS.minTokenMinor) return refuse("paj.cash pays out $0.50 or more");
    if (request.tokenMinor > PAJ_LIMITS.maxTokenMinor) return refuse("paj.cash pays out at most $10,000 at a time");
    const bank = await this.bankFor(parsed.destination.institution);
    if (!bank) return refuse("paj.cash no longer lists that bank. Choose it from the list again.");

    try {
      // paj.cash confirms the account with the bank before it writes the
      // order, so an account it cannot resolve is a 400 and no order exists.
      const order = await this.#o.client.createOfframp({
        bankCode: bank.code,
        accountNumber: parsed.destination.account,
        currency: this.#o.localCurrency,
        tokenMinor: request.tokenMinor,
        tokenDecimals: this.#o.tokenDecimals,
        mint: this.#o.mint,
        ...(this.#o.webhookURL ? { webhookURL: this.#o.webhookURL } : {}),
        description: `Nelo payout ${request.payoutId}`,
        ...(this.#o.businessFeeMinor ? { businessFeeMinor: this.#o.businessFeeMinor } : {}),
      });
      if (order.mint !== this.#o.mint) return refuse(`paj.cash asked for ${order.mint}, not the configured mint`);
      return {
        status: "accepted",
        partner: this.name,
        fidelity: this.fidelity,
        partnerReference: order.id,
        funding: { address: order.address, mint: order.mint, tokenMinor: order.tokenMinor, localMinor: order.fiatMinor },
      };
    } catch (e) {
      // A refused key is Nelo's problem, not the merchant's refusal: surface
      // it, so the operator fixes it and the same cash-out goes through.
      if (e instanceof PajError && !e.auth && e.status >= 400 && e.status < 500) return refuse(e.message);
      throw e;
    }
  }

  /**
   * Where an order stands, from paj.cash's own record. Webhooks are verified
   * and then only prompt this question; the record is what is believed.
   */
  async status(reference: string): Promise<PartnerStatus> {
    let t;
    try {
      t = await this.#o.client.transaction(reference, this.#o.tokenDecimals);
    } catch (e) {
      // An unfunded order is deleted after 72 hours and then reads as 404.
      if (e instanceof PajError && e.status === 404) return { state: null, detail: "paj.cash no longer has this order" };
      throw e;
    }
    switch (t.status) {
      case "INIT":
        return { state: "awaiting-funds", detail: "waiting for the USDC to arrive" };
      case "PROCESSING":
        return { state: "processing", detail: "USDC received; paying the bank (about 20 seconds)" };
      case "COMPLETED":
        return { state: "paid", detail: "paid to the bank account" };
      case "ERROR":
        return {
          state: "failed",
          detail: `paj.cash could not pay the bank. They refund or retry it on request: quote order ${reference}`,
        };
      default:
        return { state: null, detail: `paj.cash reports "${t.status}", which this version does not know` };
    }
  }
}
