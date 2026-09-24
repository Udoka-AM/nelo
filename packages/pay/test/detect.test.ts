/**
 * Payment validation. Every test here is an attack or a mistake that would
 * otherwise hand over goods for nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  awaitPayment,
  findReference,
  referenceFromBytes,
  validatePayment,
  type ExpectedPayment,
  type ParsedTransaction,
} from "../src/detect.ts";

const MERCHANT = "9EDhKVwHe5csswhp5PcY1DDwJRkfsrZKao7vsQPe7yrh";
const OTHER = "DZ5ujai6xNWYnLh9Gzw1e5dZ51uq8RUUNamj3C9JyvyJ";
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const OTHER_MINT = "5UsqUEFzRafPihpUFbcPCKUyqXKrkXxF9wzyv3zXg4HV";

const EXPECTED: ExpectedPayment = {
  recipient: MERCHANT,
  splToken: USDC,
  amountBaseUnits: 12_500_000n, // $12.50
};

function tx(opts: {
  err?: unknown;
  pre?: [string, string, string][];
  post?: [string, string, string][];
}): ParsedTransaction {
  const map = (rows?: [string, string, string][]) =>
    (rows ?? []).map(([owner, mint, amount]) => ({
      owner,
      mint,
      uiTokenAmount: { amount },
    }));
  return {
    meta: { err: opts.err ?? null, preTokenBalances: map(opts.pre), postTokenBalances: map(opts.post) },
  };
}

test("accepts an exact payment", () => {
  const result = validatePayment(
    tx({ pre: [[MERCHANT, USDC, "0"]], post: [[MERCHANT, USDC, "12500000"]] }),
    EXPECTED,
  );
  assert.equal(result.paid, true);
  if (result.paid) {
    assert.equal(result.amountBaseUnits, 12_500_000n);
    assert.equal(result.overpaid, false);
  }
});

test("accepts a first-ever payment, where the merchant had no token account", () => {
  // No pre-balance entry at all: the ATA was created by this transaction.
  const result = validatePayment(tx({ post: [[MERCHANT, USDC, "12500000"]] }), EXPECTED);
  assert.equal(result.paid, true);
});

test("accepts an overpayment, and says so", () => {
  const result = validatePayment(
    tx({ pre: [[MERCHANT, USDC, "0"]], post: [[MERCHANT, USDC, "13000000"]] }),
    EXPECTED,
  );
  assert.equal(result.paid, true);
  if (result.paid) assert.equal(result.overpaid, true);
});

// ------------------------------------------------------------- attacks ---

test("refuses an underpayment", () => {
  // The interesting one: a real transfer, a real reference, one cent short.
  const result = validatePayment(
    tx({ pre: [[MERCHANT, USDC, "0"]], post: [[MERCHANT, USDC, "12499999"]] }),
    EXPECTED,
  );
  assert.equal(result.paid, false);
  if (!result.paid) assert.match(result.reason, /underpaid/);
});

test("refuses payment to someone else", () => {
  const result = validatePayment(
    tx({ pre: [[OTHER, USDC, "0"]], post: [[OTHER, USDC, "12500000"]] }),
    EXPECTED,
  );
  assert.equal(result.paid, false);
  if (!result.paid) assert.match(result.reason, /no tokens reached the merchant/);
});

test("refuses payment in the wrong token", () => {
  // A worthless token, the right amount, the right merchant.
  const result = validatePayment(
    tx({ pre: [[MERCHANT, OTHER_MINT, "0"]], post: [[MERCHANT, OTHER_MINT, "12500000"]] }),
    EXPECTED,
  );
  assert.equal(result.paid, false);
});

test("refuses a failed transaction", () => {
  const result = validatePayment(
    tx({
      err: { InstructionError: [0, "Custom"] },
      pre: [[MERCHANT, USDC, "0"]],
      post: [[MERCHANT, USDC, "12500000"]],
    }),
    EXPECTED,
  );
  assert.equal(result.paid, false);
  if (!result.paid) assert.match(result.reason, /failed on chain/);
});

test("refuses a transaction that merely mentions the reference", () => {
  // Anyone can name any account. Moving nothing must never read as payment.
  assert.equal(validatePayment(tx({}), EXPECTED).paid, false);
});

test("refuses a withdrawal dressed up as a payment", () => {
  // Balance goes down, not up. A naive absolute-value check would pass this.
  const result = validatePayment(
    tx({ pre: [[MERCHANT, USDC, "12500000"]], post: [[MERCHANT, USDC, "0"]] }),
    EXPECTED,
  );
  assert.equal(result.paid, false);
});

test("refuses a transaction with no metadata", () => {
  assert.equal(validatePayment({ meta: null }, EXPECTED).paid, false);
  assert.equal(validatePayment({}, EXPECTED).paid, false);
});

test("sums multiple credits to the same merchant", () => {
  // A wallet may split across instructions; the total is what matters.
  const result = validatePayment(
    tx({
      pre: [[MERCHANT, USDC, "0"]],
      post: [
        [MERCHANT, USDC, "6000000"],
        [MERCHANT, USDC, "6500000"],
      ],
    }),
    EXPECTED,
  );
  assert.equal(result.paid, true);
});

// ----------------------------------------------------------- references ---

test("a reference is 32 bytes, base58", () => {
  const reference = referenceFromBytes(new Uint8Array(32).fill(9));
  assert.ok(reference.length > 30 && reference.length <= 44);
});

test("references reject the wrong length", () => {
  assert.throws(() => referenceFromBytes(new Uint8Array(31)), /32 bytes/);
});

// ------------------------------------------------------------- the wire ---
//
// The half that had no tests at all, and the half that was broken. Every
// assertion below is about what leaves the phone, not what comes back.

/** A fetch that records the JSON-RPC bodies it was asked to send. */
function rpcStub(results: unknown[]) {
  const sent: { method: string; params: unknown[] }[] = [];
  let call = 0;
  const fetch = (async (_url: any, options: any) => {
    const body = JSON.parse(options.body);
    sent.push({ method: body.method, params: body.params });
    const result = results[Math.min(call, results.length - 1)];
    call += 1;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}

function withFetch<T>(fetch: typeof globalThis.fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fetch;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

const REFERENCE = "9EDhKVwHe5csswhp5PcY1DDwJRkfsrZKao7vsQPe7yrh";

/**
 * The bug this file existed without. `getSignaturesForAddress` takes exactly
 * two parameters — the address, then a config object — and the commitment lives
 * inside that object. It was being sent as a loose third parameter, so every
 * poll was malformed and the terminal never saw a paid sale.
 */
test("findReference sends two params, with commitment inside the config", async () => {
  const { fetch, sent } = rpcStub([[{ signature: "sig1", err: null }]]);
  await withFetch(fetch, () => findReference("http://rpc.invalid", REFERENCE));

  assert.equal(sent[0].method, "getSignaturesForAddress");
  assert.equal(sent[0].params.length, 2, "a loose third parameter is malformed");
  assert.equal(sent[0].params[0], REFERENCE);
  assert.deepEqual(sent[0].params[1], { limit: 10, commitment: "confirmed" });
});

/**
 * Not pedantry: `commitment` defaults to `finalized`, roughly thirteen seconds
 * behind `confirmed`. A till that waits for finality keeps the customer at the
 * counter for no reason.
 */
test("the commitment asked for is confirmed, not left to default to finalized", async () => {
  const { fetch, sent } = rpcStub([[]]);
  await withFetch(fetch, () => findReference("http://rpc.invalid", REFERENCE));
  assert.equal((sent[0].params[1] as { commitment: string }).commitment, "confirmed");
});

test("no signatures yet is null, not an error", async () => {
  const { fetch } = rpcStub([[]]);
  const found = await withFetch(fetch, () => findReference("http://rpc.invalid", REFERENCE));
  assert.equal(found, null);
});

test("the oldest signature wins — the payment is the first to name the reference", async () => {
  const { fetch } = rpcStub([
    [
      { signature: "newest", err: null },
      { signature: "oldest", err: null },
    ],
  ]);
  const found = await withFetch(fetch, () => findReference("http://rpc.invalid", REFERENCE));
  assert.equal(found, "oldest");
});

// ------------------------------------------------------ failures, visibly ---

/**
 * The second half of the same defect. The old `catch {}` could not tell a
 * network blink from a request that will be rejected every single time, and the
 * difference is the whole bug: one is patience, the other is a terminal
 * pretending to watch.
 */
test("a failing poll is reported rather than swallowed, and does not end the sale", async () => {
  const failures: number[] = [];
  const fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof globalThis.fetch;

  const outcome = await withFetch(fetch, () =>
    awaitPayment("http://rpc.invalid", REFERENCE, EXPECTED, {
      timeoutMs: 40,
      intervalMs: 5,
      onPollError: (_error, consecutive) => failures.push(consecutive),
    }),
  );

  assert.equal(outcome.status, "timeout", "the sale ends on its own terms, not on an RPC error");
  assert.ok(failures.length >= 2, `expected repeated reports, got ${failures.length}`);
  // Consecutive, so a caller can tell one blink from a wall.
  assert.deepEqual(failures.slice(0, 3), [1, 2, 3].slice(0, failures.length));
});

test("the failure count resets once polling recovers", async () => {
  let call = 0;
  const seen: number[] = [];
  const fetch = (async () => {
    call += 1;
    if (call <= 2) return new Response("nope", { status: 500 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;

  await withFetch(fetch, () =>
    awaitPayment("http://rpc.invalid", REFERENCE, EXPECTED, {
      timeoutMs: 40,
      intervalMs: 5,
      onPollError: (_e, consecutive) => seen.push(consecutive),
    }),
  );
  assert.deepEqual(seen, [1, 2], "a recovered poll must not keep counting old failures");
});

// ----------------------------------------------------------- not giving up ---

/**
 * **This is the test that catches a hard-coded deadline**, and it earns its
 * place by construction: the abort at thirty polls is a safety net, not the
 * expected stop. Twenty milliseconds at five-millisecond intervals is about
 * five polls, so reaching thirty means `timeoutMs` was ignored.
 *
 * Worth saying why it is written this way. The sibling test below — "keeps
 * watching when timeoutMs is null" — **passes either way**, because an abort
 * ends the loop whether the deadline is honoured or hard-coded at two minutes.
 * It documents the intent; it does not prove it. This one does.
 */
test("a finite timeoutMs is honoured rather than ignored", async () => {
  let polls = 0;
  const controller = new AbortController();
  const fetch = (async () => {
    polls += 1;
    if (polls >= 30) controller.abort();
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;

  const outcome = await withFetch(fetch, () =>
    awaitPayment("http://rpc.invalid", REFERENCE, EXPECTED, {
      timeoutMs: 20,
      intervalMs: 5,
      signal: controller.signal,
    }),
  );

  assert.equal(outcome.status, "timeout");
  assert.ok(polls < 30, `the deadline was ignored — polled ${polls} times before the safety abort`);
});

/**
 * The code stays on screen until the merchant takes it down, so the watch must
 * too. The old two-minute default returned `timeout`, and nothing restarted it
 * — a customer paying at 2m01s was never seen, while the screen still said the
 * code was valid.
 */
test("keeps watching when timeoutMs is null, until aborted", async () => {
  let polls = 0;
  const controller = new AbortController();
  const fetch = (async () => {
    polls += 1;
    if (polls >= 6) controller.abort();
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;

  const outcome = await withFetch(fetch, () =>
    awaitPayment("http://rpc.invalid", REFERENCE, EXPECTED, {
      timeoutMs: null,
      intervalMs: 1,
      signal: controller.signal,
    }),
  );

  assert.equal(outcome.status, "timeout");
  assert.ok(polls >= 6, `stopped after ${polls} polls — it should have kept going`);
});

test("a payment found on a later poll is still caught", async () => {
  let call = 0;
  const fetch = (async (_url: any, options: any) => {
    const body = JSON.parse(options.body);
    call += 1;
    let result: unknown = [];
    if (body.method === "getSignaturesForAddress") {
      result = call < 4 ? [] : [{ signature: "late", err: null }];
    } else {
      result = {
        meta: {
          err: null,
          preTokenBalances: [{ owner: MERCHANT, mint: USDC, uiTokenAmount: { amount: "0" } }],
          postTokenBalances: [
            { owner: MERCHANT, mint: USDC, uiTokenAmount: { amount: "12500000" } },
          ],
        },
      };
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;

  const outcome = await withFetch(fetch, () =>
    awaitPayment("http://rpc.invalid", REFERENCE, EXPECTED, { timeoutMs: null, intervalMs: 1 }),
  );

  assert.equal(outcome.status, "paid");
  if (outcome.status === "paid") assert.equal(outcome.signature, "late");
});
