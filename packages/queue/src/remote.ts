/**
 * Talking to Nelo's relayer and to an RPC node, for any phone that settles
 * vouchers: the merchant's till, or a customer who was paid by another.
 *
 * The relayer builds, pays for and sends each redemption, so whoever settles
 * signs nothing and needs no SOL. It answers a voucher it has already sent
 * with the same signature while that transaction can still land, which is
 * what makes asking again after a crash safe.
 *
 * `fetch` is injected so this runs under test exactly as it runs on a phone.
 */
import { encodeBase64 } from "@nelo/voucher";
import type { Entry } from "./queue.ts";
import type { Declined, Prepared, SignatureStatus } from "./settle.ts";

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface Relayer {
  /** Base URL, without a trailing slash. */
  url: string;
  /** Bearer token, if the relayer wants one. */
  token?: string;
  fetch?: Fetch;
}

const post = (r: Relayer, path: string, body: unknown) =>
  (r.fetch ?? (fetch as unknown as Fetch))(`${r.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(r.token ? { authorization: `Bearer ${r.token}` } : {}) },
    body: JSON.stringify(body),
  });

type RedeemAnswer =
  | { status: "sent"; signature: string }
  | { status: "rejected"; err: unknown }
  | { status: "declined"; reason: string; retryable: boolean; conflict?: boolean };

/**
 * `SettleDeps.prepare`, through the relayer. Throws, which the queue reads as
 * offline, when the relayer cannot be reached or answers with a 5xx.
 */
export function relayPrepare(r: Relayer): (entry: Entry) => Promise<Prepared | Declined> {
  return async (entry) => {
    const response = await post(r, "/v1/redeem", { packet: encodeBase64(entry.packet) });
    if (response.status >= 500) throw new Error(`relayer unavailable (${response.status})`);
    if (!response.ok) {
      return { declined: { RelayDeclined: { reason: `HTTP ${response.status}`, retryable: false } } };
    }
    const answer = (await response.json()) as RedeemAnswer;
    switch (answer.status) {
      case "sent":
        // Already sent by the relayer; there is nothing left to do but record it.
        return { signature: answer.signature, send: async () => ({ kind: "sent" }) };
      case "rejected":
        // Simulation refused it and nothing landed: classify the chain's error.
        return { declined: answer.err };
      case "declined":
        return {
          declined: {
            RelayDeclined: { reason: answer.reason, retryable: answer.retryable, conflict: answer.conflict === true },
          },
        };
      default:
        throw new Error("the relayer's answer was not understood");
    }
  };
}

export type ConflictOutcome =
  /** Reported, or already frozen: nothing more to do. */
  | { done: true; status: string }
  /** Not now: offline, the relayer's budget, or the chain said no this time. */
  | { done: false };

/**
 * Hand a double spend to the relayer: two different vouchers at one sequence,
 * base64. It freezes the payer's vault, and its sweep then slashes the stake.
 */
export async function reportConflict(r: Relayer, a: Uint8Array, b: Uint8Array): Promise<ConflictOutcome> {
  let answer: { status?: string; reason?: string };
  try {
    const response = await post(r, "/v1/conflict", { a: encodeBase64(a), b: encodeBase64(b) });
    if (response.status >= 500) return { done: false };
    answer = ((await response.json().catch(() => ({}))) ?? {}) as typeof answer;
  } catch {
    return { done: false };
  }
  switch (answer.status) {
    case "reported":
    case "already-frozen":
      return { done: true, status: answer.status };
    case "declined":
      // A spent budget is worth asking again; anything else (not proof, no
      // such vault) will get the same answer every time.
      return /budget/.test(answer.reason ?? "") ? { done: false } : { done: true, status: "declined" };
    default:
      return { done: false };
  }
}

/** `SettleDeps.statuses` over JSON-RPC, searching history so old landings are found. */
export function rpcStatuses(
  rpcUrl: string,
  fetchImpl?: Fetch,
): (signatures: readonly string[]) => Promise<ReadonlyMap<string, SignatureStatus>> {
  return async (signatures) => {
    const response = await (fetchImpl ?? (fetch as unknown as Fetch))(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getSignatureStatuses",
        params: [[...signatures], { searchTransactionHistory: true }],
      }),
    });
    if (!response.ok) throw new Error(`getSignatureStatuses: HTTP ${response.status}`);
    const body = (await response.json()) as {
      result?: { value: ({ err: unknown; confirmationStatus: string | null } | null)[] };
      error?: { message?: string };
    };
    if (!body.result) throw new Error(`getSignatureStatuses: ${body.error?.message ?? "no result"}`);
    const out = new Map<string, SignatureStatus>();
    signatures.forEach((signature, i) => {
      const s = body.result!.value[i];
      if (!s) out.set(signature, { kind: "not-found" });
      else if (s.err) out.set(signature, { kind: "failed", err: s.err });
      else if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") {
        out.set(signature, { kind: "confirmed" });
      } else out.set(signature, { kind: "processing" });
    });
    return out;
  };
}
