/**
 * Did the customer actually pay?
 *
 * Solana Pay's mechanism is a *reference*: a random 32-byte key the merchant
 * puts in the request, which the wallet includes as a read-only account. The
 * merchant then watches the chain for a transaction mentioning it.
 *
 * The trap is treating "a transaction mentions my reference" as "I was paid".
 * Anyone can build a transaction naming any account, so finding a signature
 * proves only that *something* happened. Every payment must be validated
 * against what was actually asked for — right payee, right mint, right amount,
 * and the transaction did not fail. That validation is the pure part below,
 * and it is where the tests are.
 */
import { encodeBase58 } from "./base58.ts";

/** A reference is a marker, never a signer — 32 random bytes is all it needs. */
export function referenceFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 32) {
    throw new Error(`a reference needs 32 bytes, got ${bytes.length}`);
  }
  return encodeBase58(bytes);
}

export interface ExpectedPayment {
  /** The merchant's wallet, base58 — the token account *owner*, not the ATA. */
  recipient: string;
  /** SPL mint, base58. */
  splToken: string;
  /** What the customer was asked for, in base units. */
  amountBaseUnits: bigint;
}

/** The slice of a `jsonParsed` transaction this needs. Deliberately minimal. */
export interface TokenBalance {
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}
export interface ParsedTransaction {
  meta?: {
    err?: unknown;
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | null;
}

export type Validation =
  | { paid: true; amountBaseUnits: bigint; overpaid: boolean }
  | { paid: false; reason: string };

function creditedTo(balances: TokenBalance[] | undefined, expected: ExpectedPayment): bigint {
  let total = 0n;
  for (const b of balances ?? []) {
    if (b.owner === expected.recipient && b.mint === expected.splToken) {
      total += BigInt(b.uiTokenAmount.amount);
    }
  }
  return total;
}

/**
 * Validate a transaction against what the merchant asked for.
 *
 * Works off the token-balance deltas in the transaction metadata rather than by
 * decoding instructions: the metadata carries the account *owner*, so this does
 * not have to derive an associated token address, and it is indifferent to
 * whether the wallet used `transfer` or `transferChecked`, batched, or routed
 * through several instructions.
 */
export function validatePayment(
  tx: ParsedTransaction,
  expected: ExpectedPayment,
): Validation {
  const meta = tx.meta;
  if (!meta) return { paid: false, reason: "transaction has no metadata" };

  // A failed transaction moves nothing, however convincing it looks.
  if (meta.err !== null && meta.err !== undefined) {
    return { paid: false, reason: "transaction failed on chain" };
  }

  const before = creditedTo(meta.preTokenBalances, expected);
  const after = creditedTo(meta.postTokenBalances, expected);
  const delta = after - before;

  if (delta <= 0n) {
    return { paid: false, reason: "no tokens reached the merchant in this transaction" };
  }
  if (delta < expected.amountBaseUnits) {
    // Underpayment is the interesting attack: a real transfer, a real
    // reference, and a merchant who hands over goods for a fraction.
    return {
      paid: false,
      reason: `underpaid: expected ${expected.amountBaseUnits}, received ${delta}`,
    };
  }

  return {
    paid: true,
    amountBaseUnits: delta,
    overpaid: delta > expected.amountBaseUnits,
  };
}

// ------------------------------------------------------------- the chain ---

/**
 * Minimal JSON-RPC over fetch. No SDK: this is two methods, and `fetch` works
 * identically in Node and Hermes, so nothing here needs a polyfill or a
 * bundler exception.
 */
async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) {
    throw new Error(`RPC ${method} failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`RPC ${method} failed: ${body.error.message}`);
  return body.result as T;
}

/** The signature of the first transaction naming this reference, if any. */
export async function findReference(
  rpcUrl: string,
  reference: string,
): Promise<string | null> {
  const signatures = await rpc<{ signature: string; err: unknown }[]>(
    rpcUrl,
    "getSignaturesForAddress",
    [reference, { limit: 10 }, "confirmed"],
  );
  // Oldest first: the payment is the first transaction to name the reference.
  const found = signatures.at(-1);
  return found ? found.signature : null;
}

export async function fetchTransaction(
  rpcUrl: string,
  signature: string,
): Promise<ParsedTransaction | null> {
  return rpc<ParsedTransaction | null>(rpcUrl, "getTransaction", [
    signature,
    { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
  ]);
}

export type PaymentOutcome =
  | { status: "paid"; signature: string; amountBaseUnits: bigint; overpaid: boolean }
  | { status: "invalid"; signature: string; reason: string }
  | { status: "timeout" };

/**
 * Watch for a payment against one reference.
 *
 * Returns `invalid` rather than continuing to wait when a transaction is found
 * but does not settle what was owed — a merchant at a counter needs to be told
 * "that was not enough", not left looking at a spinner.
 */
export async function awaitPayment(
  rpcUrl: string,
  reference: string,
  expected: ExpectedPayment,
  options: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<PaymentOutcome> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const intervalMs = options.intervalMs ?? 1_500;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (options.signal?.aborted) return { status: "timeout" };
    let signature: string | null = null;
    try {
      signature = await findReference(rpcUrl, reference);
    } catch {
      // A flaky RPC must not end the sale; keep polling until the deadline.
    }
    if (signature) {
      const tx = await fetchTransaction(rpcUrl, signature);
      if (tx) {
        const result = validatePayment(tx, expected);
        return result.paid
          ? {
              status: "paid",
              signature,
              amountBaseUnits: result.amountBaseUnits,
              overpaid: result.overpaid,
            }
          : { status: "invalid", signature, reason: result.reason };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { status: "timeout" };
}
