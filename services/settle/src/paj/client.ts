/**
 * A client for paj.cash's public API, version 2: https://docs.paj.cash
 *
 * One credential: the business API key, sent as `x-api-key` on every request.
 * There is no session and no per-user login in v2, and the key never leaves
 * this service: anyone holding it can register bank accounts and open orders
 * as Nelo. It is never logged.
 *
 * Production only. paj.cash has no staging environment for v2 (confirmed by
 * them, 5 Oct), so every order is real and settles in mainnet USDC.
 *
 * What it uses:
 *
 *   GET  /pub/v2/rate?currency=NGN     the off-ramp rate, Nelo's fee applied
 *   GET  /pub/v2/bank                  banks paj.cash pays, by code
 *   POST /pub/v2/bank-account          register an account: the bank's name
 *                                      for it, and paj.cash keeps it. Slow
 *                                      (a live bank call), idempotent
 *   POST /pub/v2/offramp               an order: one-off deposit address
 *   GET  /pub/v2/transaction/:id       where an order stands
 *
 * paj.cash rejects unknown body fields, so every body is built field by field
 * from the documented schema and nothing else is sent. Amounts are decimals
 * in whole tokens; they are read and written through their text, exact both
 * ways (see ./decimal.ts). `fetch` is injected so every request is tested for
 * what it puts on the wire.
 */
import { toJsonNumber, toMinor } from "./decimal.ts";

type Fetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export const PAJ_API = "https://api.paj.cash";

/** Mainnet USDC: what paj.cash settles in on Solana. */
export const USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export class PajError extends Error {
  readonly status: number;
  /** The API key was refused: a credential problem, not the merchant's. */
  readonly auth: boolean;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.auth = status === 401;
  }
}

export interface PajRate {
  /** Local currency per US dollar, as paj.cash sent it, Nelo's fee applied. */
  rate: number;
  currency: string;
}

export interface PajBank {
  id: string;
  /** What the rest of the API names the bank by. */
  code: string;
  name: string;
  country: string;
}

/** A bank account registered with paj.cash. */
export interface PajBankAccount {
  id: string;
  /** From the bank, not from the request: the name enquiry. */
  accountName: string;
  accountNumber: string;
  /** The bank's name. */
  bank: string;
  /** The standing Solana address that pays this account. Not used for cash-outs: see partner.ts. */
  address: string;
}

export interface OfframpRequest {
  bankCode: string;
  accountNumber: string;
  currency: string;
  /** Token base units. */
  tokenMinor: bigint;
  tokenDecimals: number;
  mint: string;
  webhookURL?: string;
  description?: string;
  /** Nelo's fee in USDC base units, added on top of the payout by paj.cash. */
  businessFeeMinor?: bigint;
}

export interface OfframpOrder {
  id: string;
  /** Where the tokens go. A one-off address, valid for this order only. */
  address: string;
  mint: string;
  currency: string;
  /** What to send, token base units, as paj.cash asked for it. */
  tokenMinor: bigint;
  /** What the bank account receives, local minor units. */
  fiatMinor: bigint;
  rate: number;
  feeMinor: bigint;
  status: PajStatus;
}

export type PajStatus = "INIT" | "PROCESSING" | "COMPLETED" | "ERROR" | (string & {});

export interface PajTransaction {
  id: string;
  status: PajStatus;
  type: string;
  /** The on-chain signature paj.cash saw, when there is one. */
  signature: string | null;
  tokenMinor: bigint | null;
  fiatMinor: bigint | null;
}

export interface PajClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: Fetch;
  /** Minor-unit digits of the local currency. Naira: 2. */
  localDigits?: number;
  /** Per request. Registration makes a live bank call, so the default is generous: 35 s. */
  timeoutMs?: number;
}

/** paj.cash's error message: a string, or an array when validation failed. */
function messageOf(body: unknown, status: number): string {
  const m = (body as { message?: unknown } | null)?.message;
  if (Array.isArray(m)) return m.map(String).join(", ");
  if (typeof m === "string" && m) return m;
  return `paj.cash answered HTTP ${status}`;
}

export function pajClient(options: PajClientOptions) {
  const base = (options.baseUrl ?? PAJ_API).replace(/\/+$/, "");
  const send = options.fetch ?? (fetch as unknown as Fetch);
  const localDigits = options.localDigits ?? 2;
  const timeoutMs = options.timeoutMs ?? 35_000;

  async function call<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Awaited<ReturnType<Fetch>>;
    try {
      response = await send(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json", "x-api-key": options.apiKey },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) throw new PajError(messageOf(parsed, response.status), response.status);
    return parsed as T;
  }

  return {
    /** The off-ramp rate for a currency. 404 means paj.cash has no live rate for it. */
    async offrampRate(currency: string): Promise<PajRate> {
      const r = await call<{ offRampRate?: { rate?: number; targetCurrency?: string } }>(
        "GET",
        `/pub/v2/rate?currency=${encodeURIComponent(currency)}`,
      );
      const rate = r?.offRampRate?.rate;
      if (typeof rate !== "number" || !(rate > 0)) throw new PajError("paj.cash returned no off-ramp rate", 502);
      return { rate, currency: String(r.offRampRate?.targetCurrency ?? currency) };
    },

    async banks(country?: string): Promise<PajBank[]> {
      const q = country ? `?country=${encodeURIComponent(country)}` : "";
      const r = await call<PajBank[]>("GET", `/pub/v2/bank${q}`);
      return (r ?? []).map((b) => ({ id: String(b.id), code: String(b.code), name: String(b.name), country: String(b.country) }));
    },

    /**
     * Register a bank account: paj.cash confirms it with the bank and returns
     * the holder's name. Idempotent, so it is also the name enquiry. A 400 is
     * an unknown bank code or an account the bank could not confirm.
     */
    async registerAccount(bankCode: string, accountNumber: string): Promise<PajBankAccount> {
      const r = await call<PajBankAccount>("POST", "/pub/v2/bank-account", { bankCode, accountNumber });
      if (!r?.accountName) throw new PajError("paj.cash registered the account but returned no name", 502);
      return {
        id: String(r.id),
        accountName: String(r.accountName),
        accountNumber: String(r.accountNumber),
        bank: String(r.bank),
        address: String(r.address),
      };
    },

    async createOfframp(order: OfframpRequest): Promise<OfframpOrder> {
      // Exactly the documented fields: paj.cash rejects anything else.
      const body: Record<string, unknown> = {
        bankCode: order.bankCode,
        accountNumber: order.accountNumber,
        currency: order.currency,
        amount: toJsonNumber(order.tokenMinor, order.tokenDecimals),
        mint: order.mint,
        chain: "SOLANA",
      };
      if (order.webhookURL) body.webhookURL = order.webhookURL;
      if (order.description) body.description = order.description;
      if (order.businessFeeMinor) body.businessUSDCFee = toJsonNumber(order.businessFeeMinor, order.tokenDecimals);
      const r = await call<{
        id: string;
        address: string;
        mint: string;
        currency: string;
        amount: number;
        fiatAmount: number;
        rate: number;
        fee?: number;
        status?: string;
      }>("POST", "/pub/v2/offramp", body);
      if (!r?.id || !r.address) throw new PajError("paj.cash returned an order with no id or deposit address", 502);
      return {
        id: String(r.id),
        address: String(r.address),
        mint: String(r.mint),
        currency: String(r.currency),
        tokenMinor: toMinor(r.amount, order.tokenDecimals),
        // What reaches the bank: never rounded up.
        fiatMinor: toMinor(r.fiatAmount, localDigits, "down"),
        rate: r.rate,
        feeMinor: typeof r.fee === "number" ? toMinor(r.fee, order.tokenDecimals) : 0n,
        status: String(r.status ?? "INIT"),
      };
    },

    /** An order, at any stage. 404: not ours, or unpaid and deleted after 72 h. */
    async transaction(id: string, tokenDecimals: number): Promise<PajTransaction> {
      const r = await call<{
        id: string;
        status: string;
        transactionType?: string;
        signature?: string | null;
        amount?: number;
        fiatAmount?: number;
      }>("GET", `/pub/v2/transaction/${encodeURIComponent(id)}`);
      return {
        id: String(r.id),
        status: String(r.status),
        type: String(r.transactionType ?? ""),
        signature: r.signature ? String(r.signature) : null,
        tokenMinor: typeof r.amount === "number" ? toMinor(r.amount, tokenDecimals, "down") : null,
        fiatMinor: typeof r.fiatAmount === "number" ? toMinor(r.fiatAmount, localDigits, "down") : null,
      };
    },
  };
}

export type PajClient = ReturnType<typeof pajClient>;
