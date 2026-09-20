/**
 * A client for a Kora node.
 *
 * Kora is the gasless relayer this project sponsors fees through — a Rust
 * JSON-RPC server (`kora-rpc`) holding a fee-payer key and a policy about what
 * it will sign. This is the client half.
 *
 * ## Grounded against the crate, not from memory
 *
 * Method names, request fields and response fields were read out of
 * `kora-rpc@1.0.3`'s own source rather than recalled. That matters for two of
 * them, because the wire shape is **snake_case** — serde derives it from the
 * Rust field names — while everything else in this repo is camelCase:
 *
 * ```rust
 * pub struct SignAndSendTransactionResponse { pub signature: String, pub signed_transaction: String }
 * pub struct EstimateTransactionFeeResponse { pub fee_in_lamports: u64 }
 * ```
 *
 * So the conversion happens here, once, at the boundary. A caller that guessed
 * `signedTransaction` would read `undefined` and never be told.
 *
 * ## `fetch` is injected
 *
 * Not for elegance — so this file can be tested without a Kora node, which is
 * the only way it gets tested at all before one exists.
 */

/** The subset of the Kora RPC this project uses. The node exposes more. */
export interface Kora {
  /** → the signature, once the node has signed and broadcast. */
  signAndSend(transactionBase64: string): Promise<SentTransaction>;
  /** → what this transaction would cost the relayer, in lamports. */
  estimateFee(transactionBase64: string, feeToken: string): Promise<number>;
  /** The node's own policy, as it reports it. */
  config(): Promise<unknown>;
}

export interface SentTransaction {
  signature: string;
  /** The fully signed transaction, base64 — kept because it is the receipt. */
  signedTransaction: string;
}

export interface KoraOptions {
  endpoint: string;
  /** Defaults to the global `fetch`. Injected so this is testable offline. */
  fetch?: typeof globalThis.fetch;
  /** Milliseconds. A relayer that hangs is worse than one that refuses. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function createKora(options: KoraOptions): Kora {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function call<T>(method: string, params: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await doFetch(options.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Kora's methods take a single object, not positional parameters.
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new Error(`kora ${method}: HTTP ${response.status}`);
    }

    const body = (await response.json()) as {
      result?: T;
      error?: { code?: number; message?: string };
    };

    // JSON-RPC reports failure with HTTP 200 and an `error` member, so a
    // response that only checked `response.ok` would read `result` as
    // undefined and carry on as though it had worked.
    if (body.error) {
      const code = body.error.code === undefined ? "" : ` (${body.error.code})`;
      throw new Error(`kora ${method}${code}: ${body.error.message ?? "no message"}`);
    }
    if (body.result === undefined) {
      throw new Error(`kora ${method}: neither a result nor an error`);
    }
    return body.result;
  }

  return {
    async signAndSend(transactionBase64) {
      const result = await call<{ signature: string; signed_transaction: string }>(
        "signAndSendTransaction",
        { transaction: transactionBase64 },
      );
      return { signature: result.signature, signedTransaction: result.signed_transaction };
    },

    async estimateFee(transactionBase64, feeToken) {
      const result = await call<{ fee_in_lamports: number }>("estimateTransactionFee", {
        transaction: transactionBase64,
        fee_token: feeToken,
      });
      return result.fee_in_lamports;
    },

    config() {
      return call<unknown>("getConfig", {});
    },
  };
}
