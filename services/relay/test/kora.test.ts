/**
 * The Kora client. No node is running, so `fetch` is injected and these assert
 * the two things a client gets wrong: the wire shape, and what it does when the
 * far end says no.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createKora } from "../src/kora.ts";

const ENDPOINT = "http://relay.invalid/";

/** A fetch that records what it was asked and replies with what you give it. */
function stub(body: unknown, init: { status?: number } = {}) {
  const calls: { url: string; body: any }[] = [];
  const fetch = (async (url: any, options: any) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

// ------------------------------------------------------------- the wire ---

test("signAndSend posts the method Kora actually registers", () => {
  const { fetch, calls } = stub({
    jsonrpc: "2.0",
    id: 1,
    result: { signature: "5xy", signed_transaction: "AQID" },
  });
  const kora = createKora({ endpoint: ENDPOINT, fetch });

  return kora.signAndSend("AAAA").then((sent) => {
    assert.equal(calls[0].body.method, "signAndSendTransaction");
    assert.equal(calls[0].body.jsonrpc, "2.0");
    // A single object, not positional parameters.
    assert.deepEqual(calls[0].body.params, { transaction: "AAAA" });
    assert.equal(sent.signature, "5xy");
    // The field that makes this worth testing at all.
    assert.equal(sent.signedTransaction, "AQID");
  });
});

/**
 * Kora's responses are snake_case — serde derives them from the Rust field
 * names — while everything else here is camelCase. A client that guessed
 * `signedTransaction` on the wire would read `undefined` and never be told,
 * which is why the mapping happens once at the boundary and is asserted.
 */
test("the snake_case boundary is converted, not assumed", async () => {
  const { fetch } = stub({ result: { fee_in_lamports: 5000 } });
  const kora = createKora({ endpoint: ENDPOINT, fetch });
  assert.equal(await kora.estimateFee("AAAA", "So111"), 5000);
});

test("estimateFee sends the fee token under the name Kora expects", async () => {
  const { fetch, calls } = stub({ result: { fee_in_lamports: 1 } });
  await createKora({ endpoint: ENDPOINT, fetch }).estimateFee("AAAA", "MintX");
  assert.deepEqual(calls[0].body.params, { transaction: "AAAA", fee_token: "MintX" });
});

// ---------------------------------------------------------- saying no ---

/**
 * The one that matters. JSON-RPC reports failure with **HTTP 200** and an
 * `error` member, so a client that only checked `response.ok` would read
 * `result` as undefined and carry on as though the transaction had been sent.
 */
test("a JSON-RPC error on a 200 is an error, not a silent undefined", async () => {
  const { fetch } = stub({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32000, message: "transaction contains a disallowed program" },
  });
  const kora = createKora({ endpoint: ENDPOINT, fetch });

  await assert.rejects(
    () => kora.signAndSend("AAAA"),
    (e: Error) => {
      // Both halves: the node's reason, and which call produced it.
      assert.match(e.message, /disallowed program/);
      assert.match(e.message, /signAndSendTransaction/);
      assert.match(e.message, /-32000/);
      return true;
    },
  );
});

test("an HTTP failure names the status", async () => {
  const { fetch } = stub({}, { status: 502 });
  await assert.rejects(
    () => createKora({ endpoint: ENDPOINT, fetch }).signAndSend("AAAA"),
    /HTTP 502/,
  );
});

test("a response with neither result nor error is refused rather than returned", async () => {
  const { fetch } = stub({ jsonrpc: "2.0", id: 1 });
  await assert.rejects(
    () => createKora({ endpoint: ENDPOINT, fetch }).signAndSend("AAAA"),
    /neither a result nor an error/,
  );
});

test("a node that hangs is abandoned rather than waited on", async () => {
  const fetch = (async (_url: any, options: any) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof globalThis.fetch;

  await assert.rejects(
    () => createKora({ endpoint: ENDPOINT, fetch, timeoutMs: 20 }).signAndSend("AAAA"),
    /aborted/,
  );
});
