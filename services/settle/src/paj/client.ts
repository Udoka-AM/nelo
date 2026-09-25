/**
 * A client for paj.cash's HTTP API, as its own reference describes it:
 * https://github.com/paj-cash/paj_ramp/blob/main/lib/API_REFERENCE.md
 *
 * Not their SDK. It is axios, a Solana SDK, jest and dotenv as runtime
 * dependencies, and it logs to the console on every error; the calls
 * themselves are a dozen JSON requests. `fetch` is injected so every request
 * is tested for what it puts on the wire.
 *
 * Two credentials. The business API key opens a session: paj.cash sends a
 * one-time code to an email or phone, and verifying it returns a session
 * token that expires. The session token authorises everything else. Neither
 * is ever logged, and neither belongs anywhere near the apps.
 */
import { toJsonNumber, toMinor } from "./decimal.ts";

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export const PAJ_STAGING = "https://api-staging.paj.cash";
export const PAJ_PRODUCTION = "https://api.paj.cash";

export class PajError extends Error {
  readonly status: number;
  /** The session token was refused or has expired: log in again. */
  readonly session: boolean;
  constructor(message: string, status: number, session: boolean) {
    super(message);
    this.status = status;
    this.session = session;
  }
}

export interface Session {
  token: string;
  /** Unix milliseconds. */
  expiresAt: number;
}

export interface PajRate {
  /** Local currency per US dollar, as paj.cash sent it. */
  rate: number;
  currency: string;
  active: boolean;
}

export interface PajBank {
  id: string;
  /** The central bank's code: `058` for GTBank. What onboarding stores. */
  code: string;
  name: string;
  country: string;
}

export interface OfframpRequest {
  bankId: string;
  accountNumber: string;
  currency: string;
  /** Token base units. */
  tokenMinor: bigint;
  tokenDecimals: number;
  mint: string;
  webhookURL: string;
  description?: string;
  /** Nelo's fee on top, in token base units. */
  businessFeeMinor?: bigint;
}

export interface OfframpOrder {
  id: string;
  /** Where the tokens go. */
  address: string;
  mint: string;
  currency: string;
  /** What to send, token base units, as paj.cash asked for it. */
  tokenMinor: bigint;
  /** What the bank account receives, local minor units. */
  fiatMinor: bigint;
  rate: number;
  feeMinor: bigint;
}

export type PajStatus = "INIT" | "PAID" | "COMPLETED" | "FAILED" | "CANCELLED" | (string & {});

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
  baseUrl: string;
  apiKey: string;
  fetch?: Fetch;
  /** Minor-unit digits of the local currency. Naira: 2. */
  localDigits?: number;
}

export function pajClient(options: PajClientOptions) {
  const base = options.baseUrl.replace(/\/+$/, "");
  const send = options.fetch ?? (fetch as unknown as Fetch);
  const localDigits = options.localDigits ?? 2;

  async function call<T>(method: "GET" | "POST", path: string, headers: Record<string, string>, body?: unknown): Promise<T> {
    const response = await send(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const message =
        (parsed && typeof parsed === "object" && "message" in parsed && typeof parsed.message === "string" && parsed.message) ||
        `HTTP ${response.status}`;
      throw new PajError(`paj.cash ${method} ${path.split("?")[0]}: ${message}`, response.status, response.status === 401 || response.status === 403);
    }
    return parsed as T;
  }

  const withKey = () => ({ "x-api-key": options.apiKey });
  const bearer = (session: Session) => ({ authorization: `Bearer ${session.token}` });

  return {
    /** Send a one-time code to an email or an E.164 phone number. */
    async initiate(recipient: string): Promise<void> {
      await call("POST", "/pub/initiate", withKey(), recipient.includes("@") ? { email: recipient } : { phone: recipient });
    },

    /** Exchange the code for a session token. */
    async verify(recipient: string, otp: string, device: { uuid: string; device: string }): Promise<Session> {
      const r = await call<{ token: string; expiresAt: string }>(
        "POST",
        "/pub/verify",
        withKey(),
        { ...(recipient.includes("@") ? { email: recipient } : { phone: recipient }), otp, device },
      );
      const expiresAt = Date.parse(r.expiresAt);
      if (!r.token || !Number.isFinite(expiresAt)) throw new PajError("paj.cash returned no usable session", 200, true);
      return { token: r.token, expiresAt };
    },

    /** The off-ramp rate. Public. */
    async offrampRate(): Promise<PajRate> {
      const r = await call<{ offRampRate?: { rate: number; targetCurrency: string; isActive: boolean } }>("GET", "/pub/rate", {});
      if (!r?.offRampRate || typeof r.offRampRate.rate !== "number") throw new PajError("paj.cash returned no off-ramp rate", 200, false);
      return { rate: r.offRampRate.rate, currency: r.offRampRate.targetCurrency, active: r.offRampRate.isActive === true };
    },

    async banks(session: Session): Promise<PajBank[]> {
      const r = await call<PajBank[]>("GET", "/pub/bank", bearer(session));
      return (r ?? []).map((b) => ({ id: String(b.id), code: String(b.code), name: String(b.name), country: String(b.country) }));
    },

    /** Name enquiry: who holds this account. */
    async resolveAccount(session: Session, bankId: string, accountNumber: string): Promise<{ accountName: string }> {
      const q = `bankId=${encodeURIComponent(bankId)}&accountNumber=${encodeURIComponent(accountNumber)}`;
      const r = await call<{ accountName: string }>("GET", `/pub/bank-account/confirm?${q}`, bearer(session));
      return { accountName: String(r.accountName) };
    },

    async createOfframp(session: Session, order: OfframpRequest): Promise<OfframpOrder> {
      const r = await call<{
        id: string;
        address: string;
        mint: string;
        currency: string;
        amount: number;
        fiatAmount: number;
        rate: number;
        fee?: number;
      }>("POST", "/pub/offramp", bearer(session), {
        bank: order.bankId,
        accountNumber: order.accountNumber,
        currency: order.currency,
        amount: toJsonNumber(order.tokenMinor, order.tokenDecimals),
        mint: order.mint,
        chain: "SOLANA",
        webhookURL: order.webhookURL,
        ...(order.description ? { description: order.description } : {}),
        ...(order.businessFeeMinor ? { businessUSDCFee: toJsonNumber(order.businessFeeMinor, order.tokenDecimals) } : {}),
      });
      if (!r?.id || !r.address) throw new PajError("paj.cash returned an order with no id or deposit address", 200, false);
      return {
        id: String(r.id),
        address: String(r.address),
        mint: String(r.mint),
        currency: String(r.currency),
        tokenMinor: toMinor(r.amount, order.tokenDecimals),
        // What reaches the bank: never rounded up.
        fiatMinor: toMinor(r.fiatAmount, localDigits, "down"),
        rate: r.rate,
        feeMinor: r.fee === undefined ? 0n : toMinor(r.fee, order.tokenDecimals),
      };
    },

    async transaction(session: Session, id: string, tokenDecimals: number): Promise<PajTransaction> {
      const r = await call<{
        id: string;
        status: string;
        transactionType?: string;
        signature?: string | null;
        amount?: number;
        fiatAmount?: number;
      }>("GET", `/pub/transactions/${encodeURIComponent(id)}`, bearer(session));
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
