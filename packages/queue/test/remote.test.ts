/**
 * The relayer and RPC clients, against a fake `fetch` that answers from a
 * script and records what it was asked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, relayPrepare, reportConflict, rpcStatuses } from "../src/index.ts";
import { entry, onRedeem, packet } from "./fixtures.ts";

function fakeFetch(answer: (url: string, body: any) => { status: number; body?: unknown } | Error) {
  const asked: { url: string; headers: Record<string, string>; body: any }[] = [];
  const f = async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    asked.push({ url, headers: init?.headers ?? {}, body });
    const a = answer(url, body);
    if (a instanceof Error) throw a;
    return { ok: a.status < 300, status: a.status, json: async () => a.body };
  };
  return { f, asked };
}

test("a voucher goes to the relayer as base64, with the token, and a sent answer is recorded", async () => {
  const e = entry();
  const net = fakeFetch(() => ({ status: 200, body: { status: "sent", signature: "sig1" } }));
  const p = await relayPrepare({ url: "https://relay", token: "t0k", fetch: net.f })(e);
  assert.equal(net.asked[0]!.url, "https://relay/v1/redeem");
  assert.equal(net.asked[0]!.headers.authorization, "Bearer t0k");
  assert.equal(net.asked[0]!.body.packet, Buffer.from(e.packet).toString("base64"));
  assert.ok("signature" in p && p.signature === "sig1");
  if ("send" in p) assert.deepEqual(await p.send(), { kind: "sent" }, "the relayer already sent it");
});

test("the relayer unreachable, or failing, reads as offline", async () => {
  const down = fakeFetch(() => new Error("socket hang up"));
  await assert.rejects(relayPrepare({ url: "u", fetch: down.f })(entry()));
  const broken = fakeFetch(() => ({ status: 502 }));
  await assert.rejects(relayPrepare({ url: "u", fetch: broken.f })(entry()));
});

test("the relayer's refusals classify as the queue expects", async () => {
  const cases: [unknown, string, string][] = [
    [{ status: "rejected", err: onRedeem("SequenceAlreadyRedeemed") }, "refused", "paid-to-someone-else"],
    [{ status: "declined", reason: "budget", retryable: true }, "blocked", "relay-declined"],
    [{ status: "declined", reason: "x", retryable: false, conflict: true }, "refused", "paid-to-someone-else"],
  ];
  for (const [body, kind, reason] of cases) {
    const net = fakeFetch(() => ({ status: 200, body }));
    const p = await relayPrepare({ url: "u", fetch: net.f })(entry());
    assert.ok("declined" in p);
    const v = classify((p as { declined: unknown }).declined);
    assert.equal(v.kind, kind);
    assert.equal(v.reason, reason);
  }
});

test("a conflict report is done once reported or already frozen, and asked again otherwise", async () => {
  const a = packet({ amount: 1n });
  const b = packet({ amount: 2n });
  const outcome = async (answer: Parameters<typeof fakeFetch>[0]) => {
    const net = fakeFetch(answer);
    const r = await reportConflict({ url: "u", fetch: net.f }, a, b);
    return { r, asked: net.asked };
  };
  const reported = await outcome(() => ({ status: 200, body: { status: "reported", signature: "s" } }));
  assert.deepEqual(reported.r, { done: true, status: "reported" });
  assert.equal(reported.asked[0]!.url, "u/v1/conflict");
  assert.equal(reported.asked[0]!.body.a, Buffer.from(a).toString("base64"));
  assert.equal(reported.asked[0]!.body.b, Buffer.from(b).toString("base64"));

  assert.equal((await outcome(() => ({ status: 200, body: { status: "already-frozen" } }))).r.done, true);
  assert.equal((await outcome(() => ({ status: 200, body: { status: "declined", reason: "not a conflict" } }))).r.done, true);
  // Worth asking again: a spent budget, the chain refusing this time, the relayer down.
  assert.equal(
    (await outcome(() => ({ status: 200, body: { status: "declined", reason: "the relayer's budget for this window is spent" } }))).r.done,
    false,
  );
  assert.equal((await outcome(() => ({ status: 200, body: { status: "rejected", err: "x" } }))).r.done, false);
  assert.equal((await outcome(() => ({ status: 503 }))).r.done, false);
  assert.equal((await outcome(() => new Error("offline"))).r.done, false);
});

test("signature statuses search history and read every shape", async () => {
  const net = fakeFetch(() => ({
    status: 200,
    body: {
      result: {
        value: [
          { err: null, confirmationStatus: "finalized" },
          { err: null, confirmationStatus: "processed" },
          { err: { InstructionError: [1, { Custom: 1 }] }, confirmationStatus: "confirmed" },
          null,
        ],
      },
    },
  }));
  const m = await rpcStatuses("https://rpc", net.f)(["a", "b", "c", "d"]);
  assert.deepEqual(net.asked[0]!.body.params[1], { searchTransactionHistory: true });
  assert.deepEqual([...m.values()].map((s) => s.kind), ["confirmed", "processing", "failed", "not-found"]);
  const bad = fakeFetch(() => ({ status: 200, body: { error: { message: "rate limited" } } }));
  await assert.rejects(rpcStatuses("r", bad.f)(["a"]), /rate limited/);
});
