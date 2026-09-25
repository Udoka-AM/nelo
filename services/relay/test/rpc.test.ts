/**
 * The relayer's RPC client over `@nelo/rpc`'s failover: a node that cannot
 * answer is skipped, and a node that answers "no" is believed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { failover } from "@nelo/rpc";
import { createRelayRpc } from "../src/index.ts";

const A = "https://a.example";
const B = "https://b.example";

function net(answers: Record<string, (method: string) => unknown>) {
  const asked: string[] = [];
  const f = async (url: string, init?: { body?: unknown }) => {
    const { method } = JSON.parse(String(init?.body)) as { method: string };
    asked.push(`${url} ${method}`);
    const a = answers[url]!(method);
    if (a instanceof Error) throw a;
    const { status, ...body } = a as { status?: number };
    return new Response(JSON.stringify(body), { status: status ?? 200 });
  };
  return { f, asked };
}

test("a send moves past a node that is behind, and a simulation refusal comes back as the chain's", async () => {
  const err = { InstructionError: [1, { Custom: 6010 }] };
  const n = net({
    [A]: () => ({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "Node is behind by 120 slots" } }),
    [B]: () => ({ jsonrpc: "2.0", id: 1, error: { code: -32002, message: "Transaction simulation failed", data: { err } } }),
  });
  const endpoint = failover([A, B], { fetch: n.f });
  const rpc = createRelayRpc(endpoint.url, endpoint.fetch);
  assert.deepEqual(await rpc.send("AQID"), { ok: false, err });
  assert.deepEqual(n.asked, [`${A} sendTransaction`, `${B} sendTransaction`]);
});

test("with the first endpoint down, reads come from the next", async () => {
  const n = net({
    [A]: () => new Error("ECONNREFUSED"),
    [B]: (m) => (m === "getBlockHeight" ? { jsonrpc: "2.0", id: 1, result: 4242 } : { status: 400 }),
  });
  const endpoint = failover([A, B], { fetch: n.f });
  assert.equal(await createRelayRpc(endpoint.url, endpoint.fetch).blockHeight(), 4242);
});
