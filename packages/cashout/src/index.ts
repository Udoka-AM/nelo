/**
 * A merchant cashing out to their bank, from the phone's side.
 *
 *   1. the settlement service opens an order with paj.cash: a deposit address
 *      and an amount;
 *   2. the relayer builds the transfer there, with itself as fee payer;
 *   3. the merchant's wallet signs it; the relayer co-signs and sends;
 *   4. the settlement service is told the transfer's signature, and from then
 *      on asks paj.cash where the payout stands.
 *
 * ## Resumable, because every step is idempotent
 *
 * The phone makes the cash-out's id once and keeps it. Opening again with the
 * same id returns the same order; preparing again returns the same transfer,
 * or its signature once sent; submitting again returns the same signature;
 * reporting it again is a no-op. So after a crash, a dead battery or a lost
 * connection, `cashOut` is simply run again with the same id, and it picks up
 * where it stopped without ever sending the USDC twice.
 */
import { getTransactionDecoder } from "@solana/kit";
import { ed25519 } from "@noble/curves/ed25519";
import { withSignature } from "@nelo/redeem";
import { decodeBase58, decodeBase64, encodeBase64 } from "@nelo/voucher";

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface Service {
  url: string;
  token?: string;
  fetch?: Fetch;
}

/** The settlement service's record of a cash-out. Amounts are base-unit strings. */
export interface CashoutRecord {
  id: string;
  state: "creating" | "awaiting-funds" | "funded" | "processing" | "paid" | "failed";
  reference: string | null;
  deposit: string | null;
  fundMinor: string | null;
  localMinor: string | null;
  transferSignature: string | null;
  detail: string;
  stale?: boolean;
}

export class ServiceError extends Error {
  readonly status: number;
  /** The settlement service needs its operator to log in to paj.cash again. */
  readonly login: boolean;
  constructor(message: string, status: number, login: boolean) {
    super(message);
    this.status = status;
    this.login = login;
  }
}

async function call<T>(s: Service, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const send = s.fetch ?? (fetch as unknown as Fetch);
  const response = await send(`${s.url}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(s.token ? { authorization: `Bearer ${s.token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed = (await response.json().catch(() => ({}))) as { error?: string; login?: boolean };
  if (!response.ok) {
    throw new ServiceError(parsed.error ?? `HTTP ${response.status}`, response.status, parsed.login === true);
  }
  return parsed as T;
}

export const settleService = (s: Service) => ({
  rate: () => call<{ rate: string; currency: string; fidelity: string; localPerToken: string; scale: number }>(s, "GET", "/v1/rate"),
  banks: () => call<{ code: string; name: string }[]>(s, "GET", "/v1/banks"),
  resolve: (code: string, account: string) =>
    call<{ accountName: string; bank: string }>(s, "GET", `/v1/banks/${encodeURIComponent(code)}/accounts/${encodeURIComponent(account)}`),
  open: (input: { id: string; merchant: string; destination: string; amount: bigint }) =>
    call<CashoutRecord>(s, "POST", "/v1/cashouts", { ...input, amount: input.amount.toString() }),
  get: (id: string) => call<CashoutRecord>(s, "GET", `/v1/cashouts/${encodeURIComponent(id)}`),
  funded: (id: string, signature: string) =>
    call<CashoutRecord>(s, "POST", `/v1/cashouts/${encodeURIComponent(id)}/funded`, { signature }),
});

type Prepared =
  | { status: "prepared"; wire: string }
  | { status: "sent"; signature: string }
  | { status: "declined"; reason: string; retryable: boolean };
type Submitted = { status: "sent"; signature: string } | { status: "rejected"; err: unknown } | { status: "declined"; reason: string };

export const relayService = (s: Service) => ({
  prepare: (input: { order: string; owner: string; deposit: string; amount: string }) => call<Prepared>(s, "POST", "/v1/cashout/prepare", input),
  submit: (order: string, wire: Uint8Array) => call<Submitted>(s, "POST", "/v1/cashout/submit", { order, wire: encodeBase64(wire) }),
});

/** Signs a whole transaction and returns it, the way Mobile Wallet Adapter does. */
export type TransactionSigner = (wire: Uint8Array) => Promise<Uint8Array>;

export type Outcome =
  | { kind: "sent"; cashout: CashoutRecord }
  | { kind: "done"; cashout: CashoutRecord }
  | { kind: "refused"; reason: string; cashout?: CashoutRecord }
  | { kind: "wait"; reason: string };

export interface CashOutInput {
  id: string;
  merchant: string;
  destination: string;
  amount: bigint;
}

/**
 * Run a cash-out from wherever it stopped. Throws only when a service cannot
 * be reached; everything else is an outcome the screen can show.
 */
export async function cashOut(
  input: CashOutInput,
  deps: { settle: ReturnType<typeof settleService>; relay: ReturnType<typeof relayService>; sign: TransactionSigner },
): Promise<Outcome> {
  let record: CashoutRecord;
  try {
    record = await deps.settle.open(input);
  } catch (e) {
    if (e instanceof ServiceError && !e.login && e.status >= 400 && e.status < 500) {
      return e.status === 429 ? { kind: "wait", reason: e.message } : { kind: "refused", reason: e.message };
    }
    throw e;
  }
  if (record.state === "failed") return { kind: "refused", reason: record.detail, cashout: record };
  if (record.transferSignature || record.state !== "awaiting-funds") return { kind: "done", cashout: record };
  if (!record.reference || !record.deposit || !record.fundMinor) {
    return { kind: "refused", reason: "the settlement service gave nowhere to send the USDC", cashout: record };
  }

  const prepared = await deps.relay.prepare({ order: record.reference, owner: input.merchant, deposit: record.deposit, amount: record.fundMinor });
  let signature: string;
  if (prepared.status === "declined") {
    return prepared.retryable ? { kind: "wait", reason: prepared.reason } : { kind: "refused", reason: prepared.reason, cashout: record };
  } else if (prepared.status === "sent") {
    // Sent before a crash that lost the report: just report it now.
    signature = prepared.signature;
  } else {
    const signed = await deps.sign(decodeBase64(prepared.wire));
    const submitted = await deps.relay.submit(record.reference, signed);
    if (submitted.status === "declined") return { kind: "refused", reason: submitted.reason, cashout: record };
    if (submitted.status === "rejected") {
      return { kind: "refused", reason: `the transfer was refused: ${JSON.stringify(submitted.err)}`, cashout: record };
    }
    signature = submitted.signature;
  }
  return { kind: "sent", cashout: await deps.settle.funded(input.id, signature) };
}

/**
 * A signer for a wallet that signs messages rather than transactions, such
 * as Privy's embedded Solana wallet. Its signature over the transaction's
 * message bytes is the transaction signature, but only if the wallet signed
 * exactly those bytes; so it is checked against the owner's key before it is
 * used. Encodings are tried in turn, and one that does not verify is not a
 * signature at all.
 */
export function messageSigner(owner: string, signMessage: (messageBase64: string) => Promise<string>): TransactionSigner {
  return async (wire) => {
    const message = new Uint8Array(getTransactionDecoder().decode(wire).messageBytes);
    const answer = await signMessage(encodeBase64(message));
    const key = decodeBase58(owner);
    for (const decode of [decodeBase64, decodeBase58]) {
      let signature: Uint8Array;
      try {
        signature = decode(answer);
      } catch {
        continue;
      }
      if (signature.length === 64 && ed25519.verify(signature, message, key)) return withSignature(wire, owner, signature);
    }
    throw new Error("The wallet's signature does not verify over this transfer, so it was not sent.");
  };
}
