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
import { encodeBase58 } from "@nelo/voucher";
import { rpc, type RpcTarget } from "./rpc.ts";

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
 * The signature of the first transaction naming this reference, if any.
 *
 * **Two parameters, and `commitment` goes inside the config object.** This read
 * `[reference, { limit: 10 }, "confirmed"]` for its whole life — three
 * parameters, with the commitment loose on the end. `getSignaturesForAddress`
 * takes `(address, config)`, so that request was malformed on every poll, and
 * `awaitPayment` swallowed the error: the terminal watched a paid sale forever
 * and never noticed.
 *
 * The shape was borrowed from `getTokenAccountsByOwner` in `balance.ts`, which
 * genuinely does take three — `(owner, filter, config)`. Ten lines below,
 * `fetchTransaction` had it right all along. Nothing caught it because no test
 * asserted what went on the wire; `test/detect.test.ts` now does.
 *
 * `commitment` matters beyond being well-formed: it defaults to `finalized`,
 * which lags `confirmed` by around thirteen seconds. A merchant at a counter
 * should not wait out finality to hand over a loaf of bread.
 */
export async function findReference(
  rpcUrl: RpcTarget,
  reference: string,
): Promise<string | null> {
  const signatures = await rpc<{ signature: string; err: unknown }[]>(
    rpcUrl,
    "getSignaturesForAddress",
    [reference, { limit: 10, commitment: "confirmed" }],
  );
  // Oldest first: the payment is the first transaction to name the reference.
  const found = signatures.at(-1);
  return found ? found.signature : null;
}

export async function fetchTransaction(
  rpcUrl: RpcTarget,
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

export interface AwaitOptions {
  /**
   * How long to keep watching. **`null` means until aborted**, which is what a
   * terminal wants: the code is on screen until the merchant takes it down, and
   * polling that quietly stops while the QR is still displayed is a terminal
   * that lies. The old default of two minutes did exactly that — it returned
   * `timeout`, the effect that called it never re-ran, and a customer paying a
   * second later was never seen.
   */
  timeoutMs?: number | null;
  intervalMs?: number;
  signal?: AbortSignal;
  /**
   * Called for every failed poll, with the consecutive-failure count.
   *
   * This exists because the `catch {}` it replaces hid a permanently malformed
   * request behind a comment about flaky networks. A bare catch cannot tell
   * "the network blinked" from "every request we will ever send is rejected",
   * and the second one looks exactly like patience from the outside.
   *
   * Transient failures are still not the merchant's problem and should not
   * interrupt a sale — but something has to be able to see them.
   */
  onPollError?: (error: unknown, consecutiveFailures: number) => void;
}

/**
 * Watch for a payment against one reference.
 *
 * Returns `invalid` rather than continuing to wait when a transaction is found
 * but does not settle what was owed — a merchant at a counter needs to be told
 * "that was not enough", not left looking at a spinner.
 */
export async function awaitPayment(
  rpcUrl: RpcTarget,
  reference: string,
  expected: ExpectedPayment,
  options: AwaitOptions = {},
): Promise<PaymentOutcome> {
  const timeoutMs = options.timeoutMs === undefined ? 120_000 : options.timeoutMs;
  const intervalMs = options.intervalMs ?? 1_500;
  const deadline = timeoutMs === null ? Infinity : Date.now() + timeoutMs;
  let consecutiveFailures = 0;

  while (Date.now() < deadline) {
    if (options.signal?.aborted) return { status: "timeout" };
    let signature: string | null = null;
    try {
      signature = await findReference(rpcUrl, reference);
      consecutiveFailures = 0;
    } catch (error) {
      // Reported, not swallowed. A sale still must not end because one request
      // failed, so this keeps polling either way.
      consecutiveFailures += 1;
      options.onPollError?.(error, consecutiveFailures);
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
