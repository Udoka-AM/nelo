/**
 * Failover against a fake network that answers per endpoint from a script and
 * records what was asked where.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { endpointsFrom, failover } from "../src/index.ts";

type Script = (url: string) => { status?: number; body?: unknown } | Error | "hang";

function net(script: Script) {
  const asked: { url: string; body: string }[] = [];
  const f = async (url: string, init?: { body?: unknown; signal?: AbortSignal | null }) => {
    asked.push({ url, body: String(init?.body) });
    const a = script(url);
    if (a === "hang") {
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    }
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a.body ?? { jsonrpc: "2.0", id: 1, result: url }), { status: a.status ?? 200 });
  };
  return { f, asked };
}

const post = (body = '{"jsonrpc":"2.0","id":1,"method":"getHealth"}') => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body,
});

const A = "https://a.example/?api-key=SECRET";
const B = "https://b.example";
const C = "https://c.example";

test("a healthy first endpoint is the only one asked", async () => {
  const n = net(() => ({}));
  const rpc = failover([A, B], { fetch: n.f });
  const r = await rpc.fetch("ignored", post());
  assert.equal(((await r.json()) as { result: string }).result, A);
  assert.deepEqual(n.asked.map((x) => x.url), [A]);
});

test("down, rate-limited, failing or behind: the next endpoint answers", async () => {
  const cases: Script[] = [
    (u) => (u === A ? new Error("ECONNREFUSED") : {}),
    (u) => (u === A ? { status: 429 } : {}),
    (u) => (u === A ? { status: 503 } : {}),
    (u) => (u === A ? { body: { jsonrpc: "2.0", id: 1, error: { code: -32005, message: "Node is behind by 90 slots" } } } : {}),
    (u) => (u === A ? { body: { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Rate limit exceeded" } } } : {}),
  ];
  for (const script of cases) {
    const n = net(script);
    const r = await failover([A, B], { fetch: n.f }).fetch("x", post());
    assert.equal(((await r.json()) as { result: string }).result, B);
    assert.deepEqual(n.asked.map((x) => x.url), [A, B]);
  }
});

test("an endpoint that hangs is given up on at the timeout", async () => {
  const n = net((u) => (u === A ? "hang" : {}));
  const r = await failover([A, B], { fetch: n.f, timeoutMs: 20 }).fetch("x", post());
  assert.equal(((await r.json()) as { result: string }).result, B);
});

test("an answer is returned as it is, never retried elsewhere", async () => {
  // A wrong question gets the same answer from every node; asking around hides the bug.
  const invalid = { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid params" } };
  const simulation = { jsonrpc: "2.0", id: 1, error: { code: -32002, message: "Transaction simulation failed", data: { err: "x" } } };
  for (const answer of [{ body: invalid }, { body: simulation }, { status: 400, body: {} }]) {
    const n = net(() => answer);
    const r = await failover([A, B], { fetch: n.f }).fetch("x", post());
    assert.deepEqual(n.asked.map((x) => x.url), [A]);
    assert.equal(r.status, answer.status ?? 200);
    assert.deepEqual(await r.json(), answer.body);
  }
});

test("a resent transaction is the same bytes, so it is the same transaction", async () => {
  const send = '{"jsonrpc":"2.0","id":7,"method":"sendTransaction","params":["AQID"]}';
  const n = net((u) => (u === A ? new Error("socket hang up") : {}));
  await failover([A, B], { fetch: n.f }).fetch("x", post(send));
  assert.deepEqual(n.asked.map((x) => x.body), [send, send]);
});

test("an endpoint that failed rests, and is asked first again once it is back", async () => {
  let clock = 0;
  let aDown = true;
  const n = net((u) => (u === A && aDown ? { status: 502 } : {}));
  const rpc = failover([A, B], { fetch: n.f, now: () => clock, restMs: 1_000 });
  await rpc.fetch("x", post());
  n.asked.length = 0;
  await rpc.fetch("x", post());
  assert.deepEqual(n.asked.map((x) => x.url), [B], "A is resting: not asked first");
  aDown = false;
  clock += 1_000;
  n.asked.length = 0;
  await rpc.fetch("x", post());
  assert.deepEqual(n.asked.map((x) => x.url), [A], "rested, and back in front");
});

test("with every endpoint resting, all are still tried, soonest back first", async () => {
  let clock = 0;
  const down = new Set([A, B, C]);
  const n = net((u) => (down.has(u) ? { status: 500 } : {}));
  const rpc = failover([A, B, C], { fetch: n.f, now: () => clock++, restMs: 1_000 });
  await assert.rejects(rpc.fetch("x", post()));
  down.delete(C);
  n.asked.length = 0;
  const r = await rpc.fetch("x", post());
  assert.equal(((await r.json()) as { result: string }).result, C);
  assert.deepEqual(n.asked.map((x) => x.url), [A, B, C]);
});

test("when all fail, the error names each host, and never an API key", async () => {
  const n = net(() => ({ status: 503 }));
  const seen: string[] = [];
  const rpc = failover([A, B], { fetch: n.f, onFailover: (u) => seen.push(u) });
  await assert.rejects(rpc.fetch("x", post()), (e: Error) => {
    assert.match(e.message, /a\.example: HTTP 503/);
    assert.match(e.message, /b\.example: HTTP 503/);
    assert.doesNotMatch(e.message, /SECRET/);
    return true;
  });
  assert.deepEqual(seen, [A, B]);
});

test("the caller's abort stops everything, with no failover", async () => {
  const n = net(() => "hang");
  const controller = new AbortController();
  const p = failover([A, B], { fetch: n.f, timeoutMs: 10_000 }).fetch("x", { ...post(), signal: controller.signal });
  controller.abort();
  await assert.rejects(p);
  assert.deepEqual(n.asked.map((x) => x.url), [A]);
});

test("configuration: preferred, then fallbacks, then the last resort, no repeats", () => {
  assert.deepEqual(endpointsFrom(A, ` ${B}, ,${A},${C}`, B), [A, B, C]);
  assert.deepEqual(endpointsFrom(undefined, undefined, C), [C]);
  assert.throws(() => failover([]));
});
