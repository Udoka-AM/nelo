/**
 * The relayer's RPC calls, over `fetch`. Kept apart from `redeem.ts` so that
 * file is tested against a fake with the same five methods.
 */
import type { RelayRpc } from "./redeem.ts";

interface Body<T> {
  result?: T;
  error?: { message?: string; data?: { err?: unknown } };
}

export function createRelayRpc(url: string, fetchImpl: typeof fetch = fetch): RelayRpc {
  let id = 0;
  async function call<T>(method: string, params: unknown[]): Promise<Body<T>> {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
    return (await response.json()) as Body<T>;
  }
  async function result<T>(method: string, params: unknown[]): Promise<T> {
    const body = await call<T>(method, params);
    if (body.error) throw new Error(`${method}: ${body.error.message ?? "RPC error"}`);
    return body.result as T;
  }

  return {
    async latestBlockhash() {
      const r = await result<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [
        { commitment: "confirmed" },
      ]);
      return r.value;
    },
    blockHeight: () => result<number>("getBlockHeight", [{ commitment: "confirmed" }]),
    async accountExists(address) {
      const r = await result<{ value: unknown | null }>("getAccountInfo", [
        address,
        { encoding: "base64", commitment: "confirmed" },
      ]);
      return r.value !== null;
    },
    async signatureKnown(signature) {
      const r = await result<{ value: (unknown | null)[] }>("getSignatureStatuses", [
        [signature],
        { searchTransactionHistory: true },
      ]);
      return r.value[0] !== null && r.value[0] !== undefined;
    },
    async send(wireBase64) {
      const body = await call<string>("sendTransaction", [
        wireBase64,
        { encoding: "base64", preflightCommitment: "confirmed" },
      ]);
      if (!body.error) return { ok: true };
      const err = body.error.data?.err;
      if (err !== undefined && err !== null) return { ok: false, err };
      throw new Error(`sendTransaction: ${body.error.message ?? "RPC error"}`);
    },
  };
}
