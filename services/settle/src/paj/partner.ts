/**
 * paj.cash as a payout partner.
 *
 * paj.cash is not paid out of funds it already holds. It opens an order, gives
 * a deposit address, and pays the bank once the tokens arrive there. So
 * `disburse` returns `funding`: what to send, and where. Sending it is the
 * merchant's wallet's job, with Nelo's relayer paying the fee.
 *
 * Onboarding stores a bank as `bank:NG:058:0123456789`, with the central
 * bank's code. paj.cash identifies banks by its own id, so the code is looked
 * up in its bank list, which carries both.
 */
import { parseCanonical } from "@nelo/onboard";
import type { ConversionRate } from "../money.ts";
import type { DisburseRequest, DisburseResult, Fidelity, PayoutPartner, PayoutQuote } from "../partner.ts";
import { PajError, type PajBank, type PajClient, type Session } from "./client.ts";
import { rateToConversion } from "./decimal.ts";

export type CashoutState = "awaiting-funds" | "processing" | "paid" | "failed";

export interface PartnerStatus {
  /** Null: nothing new, keep what is known. */
  state: CashoutState | null;
  detail: string;
}

export interface PajPartnerOptions {
  client: PajClient;
  session: () => Session;
  /** Staging is "sandbox"; production is "live". */
  fidelity: Exclude<Fidelity, "stub">;
  mint: string;
  tokenDecimals: number;
  localCurrency: string;
  localDigits: number;
  webhookURL: string;
  /** Nelo's fee on each payout, token base units. */
  businessFeeMinor?: bigint;
  /** How long a quote is good for. Default one minute. */
  quoteTtlMs?: number;
  /** How long the bank list is reused. Default an hour. */
  banksTtlMs?: number;
  now?: () => number;
}

export class PajPartner implements PayoutPartner {
  readonly name = "paj";
  readonly fidelity: Fidelity;
  readonly #o: PajPartnerOptions;
  #banks: { at: number; list: PajBank[] } | null = null;

  constructor(options: PajPartnerOptions) {
    this.#o = options;
    this.fidelity = options.fidelity;
  }

  #now() {
    return (this.#o.now ?? Date.now)();
  }

  async rate(): Promise<{ rate: number; conversion: ConversionRate }> {
    const r = await this.#o.client.offrampRate();
    if (!r.active) throw new PajError("paj.cash's off-ramp is not active right now", 200, false);
    if (r.currency !== this.#o.localCurrency) {
      throw new PajError(`paj.cash quotes ${r.currency}, not ${this.#o.localCurrency}`, 200, false);
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

  async banks(): Promise<PajBank[]> {
    const ttl = this.#o.banksTtlMs ?? 3_600_000;
    if (this.#banks && this.#now() - this.#banks.at < ttl) return this.#banks.list;
    const list = await this.#o.client.banks(this.#o.session());
    this.#banks = { at: this.#now(), list };
    return list;
  }

  async bankFor(code: string): Promise<PajBank | null> {
    return (await this.banks()).find((b) => b.code === code) ?? null;
  }

  async resolve(code: string, accountNumber: string): Promise<{ accountName: string; bank: PajBank } | null> {
    const bank = await this.bankFor(code);
    if (!bank) return null;
    const { accountName } = await this.#o.client.resolveAccount(this.#o.session(), bank.id, accountNumber);
    return { accountName, bank };
  }

  async disburse(request: DisburseRequest): Promise<DisburseResult> {
    const refuse = (reason: string): DisburseResult => ({ status: "rejected", partner: this.name, fidelity: this.fidelity, reason });
    const parsed = parseCanonical(request.destination);
    if (!parsed.ok) return refuse(parsed.reason);
    if (parsed.destination.method !== "bank") return refuse("paj.cash pays bank accounts, not mobile money");
    if (request.localCurrency !== this.#o.localCurrency) return refuse(`configured for ${this.#o.localCurrency}`);
    const bank = await this.bankFor(parsed.destination.institution);
    if (!bank) return refuse(`paj.cash does not list bank code ${parsed.destination.institution}`);

    try {
      const order = await this.#o.client.createOfframp(this.#o.session(), {
        bankId: bank.id,
        accountNumber: parsed.destination.account,
        currency: this.#o.localCurrency,
        tokenMinor: request.tokenMinor,
        tokenDecimals: this.#o.tokenDecimals,
        mint: this.#o.mint,
        webhookURL: this.#o.webhookURL,
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
      // A lapsed session is not the merchant's refusal: surface it, so the
      // operator logs in and the same cash-out goes through.
      if (e instanceof PajError && !e.session && e.status >= 400 && e.status < 500) return refuse(e.message);
      throw e;
    }
  }

  /**
   * Where an order stands, from paj.cash itself. Webhooks are only a prompt
   * to ask: nothing documents a signature on them, so their bodies are not
   * believed.
   */
  async status(reference: string): Promise<PartnerStatus> {
    const t = await this.#o.client.transaction(this.#o.session(), reference, this.#o.tokenDecimals);
    switch (t.status) {
      case "INIT":
        return { state: "awaiting-funds", detail: "waiting for the USDC to arrive" };
      case "PAID":
        return { state: "processing", detail: "USDC received; paying the bank" };
      case "COMPLETED":
        return { state: "paid", detail: "paid to the bank account" };
      case "FAILED":
      case "CANCELLED":
        return { state: "failed", detail: `paj.cash marked it ${t.status.toLowerCase()}` };
      default:
        return { state: null, detail: `paj.cash reports "${t.status}", which this version does not know` };
    }
  }
}
