/**
 * Settle-on-reconnect against a fake network. The fake is deliberately dumb —
 * it records what it was asked and answers from a script — so every property
 * here is the orchestrator's, not the fake's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_POLICY,
  memoryStore,
  settleOnce,
  type Entry,
  type Prepared,
  type SendResult,
  type SettleDeps,
  type SignatureStatus,
} from "../src/index.ts";
import { entry, onRedeem, T0 } from "./fixtures.ts";

interface Script {
  send?: (signature: string) => SendResult;
  status?: (signature: string) => SignatureStatus;
  prepareThrows?: boolean;
  statusesThrow?: boolean;
}

function network(store: ReturnType<typeof memoryStore>, script: Script = {}) {
  let clock = T0;
  let counter = 0;
  const prepared: string[] = [];
  const looked: string[][] = [];
  const deps: SettleDeps = {
    now: () => clock,
    async prepare(e: Entry): Promise<Prepared> {
      if (script.prepareThrows) throw new Error("no route to host");
      const signature = `sig-${e.seq}-${++counter}`;
      prepared.push(signature);
      return {
        signature,
        send: async () => {
          // The one property that makes a crash survivable: by the time the
          // transaction leaves, its signature is already on disk.
          const stored = store.get(e.id)!;
          assert.ok(
            stored.inFlight.some((a) => a.signature === signature),
            "the signature must be stored before the transaction is sent",
          );
          return script.send ? script.send(signature) : { kind: "sent" };
        },
      };
    },
    async statuses(signatures) {
      if (script.statusesThrow) throw new Error("no route to host");
      looked.push([...signatures]);
      return new Map(
        signatures.map((s) => [s, script.status ? script.status(s) : ({ kind: "not-found" } as const)]),
      );
    },
  };
  return {
    deps,
    prepared,
    looked,
    advance(ms: number) {
      clock += ms;
    },
  };
}

test("a voucher is sent, then settled when its signature confirms", async () => {
  const e = entry();
  const store = memoryStore([e]);
  const net = network(store, { status: () => ({ kind: "confirmed" }) });

  const first = await settleOnce(store, net.deps);
  assert.equal(first.sent, 1);
  assert.equal(store.get(e.id)!.status, "pending");

  const second = await settleOnce(store, net.deps);
  assert.deepEqual(second.settled.map((s) => s.id), [e.id]);
  assert.equal(store.get(e.id)!.settledSignature, net.prepared[0]);
  assert.equal(net.prepared.length, 1, "never sent twice");
});

test("an attempt still in flight is looked up, not resent, however long it takes", async () => {
  const e = entry();
  const store = memoryStore([e]);
  const net = network(store, { status: () => ({ kind: "processing" }) });

  await settleOnce(store, net.deps);
  for (let i = 0; i < 5; i++) {
    net.advance(60_000);
    await settleOnce(store, net.deps);
  }
  assert.equal(net.prepared.length, 1);
  assert.equal(net.looked.length, 5);
});

test("a send that timed out but landed is found, not misread as a double spend", async () => {
  // The expensive mistake: send, lose the reply, send again, and read the
  // second attempt's "already redeemed" as fraud against the merchant.
  const e = entry();
  const store = memoryStore([e]);
  let landedYet = false;
  const net = network(store, {
    send: () => ({ kind: "unreachable", message: "timeout" }),
    status: () => (landedYet ? { kind: "confirmed" } : { kind: "not-found" }),
  });

  const r1 = await settleOnce(store, net.deps);
  assert.equal(r1.offline, true);

  net.advance(30_000); // inside the drop window: not found yet means nothing
  await settleOnce(store, net.deps);
  assert.equal(net.prepared.length, 1, "not resent while it may still land");

  landedYet = true;
  net.advance(10_000);
  const r3 = await settleOnce(store, net.deps);
  assert.deepEqual(r3.settled.map((s) => s.id), [e.id]);
  assert.equal(net.prepared.length, 1);
});

test("an attempt not found past the drop window is sent again", async () => {
  const e = entry();
  const store = memoryStore([e]);
  const net = network(store);

  await settleOnce(store, net.deps);
  net.advance(DEFAULT_POLICY.dropAfterMs);
  await settleOnce(store, net.deps); // looks it up, drops it
  await settleOnce(store, net.deps); // sends again
  assert.equal(net.prepared.length, 2);
  assert.equal(store.get(e.id)!.attempts, 2);
});

test("a preflight refusal is classified at once", async () => {
  const e = entry();
  const store = memoryStore([e]);
  const net = network(store, {
    send: () => ({ kind: "rejected", err: onRedeem("SequenceAlreadyRedeemed") }),
  });

  const r = await settleOnce(store, net.deps);
  assert.deepEqual(r.refused.map((x) => x.id), [e.id]);
  assert.equal(store.get(e.id)!.verdict?.reason, "paid-to-someone-else");
  assert.deepEqual(store.get(e.id)!.inFlight, [], "a refused preflight never landed");
});

test("a failure found on lookup is classified too", async () => {
  const e = entry();
  const store = memoryStore([e]);
  const net = network(store, { status: () => ({ kind: "failed", err: onRedeem("MintMismatch") }) });

  await settleOnce(store, net.deps);
  const r = await settleOnce(store, net.deps);
  assert.deepEqual(r.held.map((x) => x.id), [e.id]);
});

test("no network, nothing signed", async () => {
  const e = entry();
  const store = memoryStore([e]);
  const net = network(store, { prepareThrows: true });

  const r = await settleOnce(store, net.deps);
  assert.equal(r.offline, true);
  assert.deepEqual(store.get(e.id), e, "no attempt recorded for a transaction never built");
});

test("if in-flight attempts cannot be looked up, nothing is sent either", async () => {
  const inflight = entry({ seq: 1n });
  const fresh = entry({ seq: 2n });
  const store = memoryStore([inflight, fresh]);
  const net = network(store);
  await settleOnce(store, net.deps, { ...DEFAULT_POLICY, maxSubmitPerRound: 1 });
  assert.deepEqual(net.prepared.length, 1, "only the first went out");

  // `fresh` is due, but the lookup for `inflight` fails: the network is gone,
  // and signing for `fresh` would be signing into the void.
  const cut = network(store, { statusesThrow: true });
  const r = await settleOnce(store, cut.deps);
  assert.equal(r.offline, true);
  assert.equal(cut.prepared.length, 0);
});

test("a voucher past its expiry and grace is expired without being sent", async () => {
  const e = entry({ expiresAt: BigInt(T0 / 1000 - DEFAULT_POLICY.expiryGraceSeconds - 1) });
  const store = memoryStore([e]);
  const net = network(store);

  const r = await settleOnce(store, net.deps);
  assert.deepEqual(r.expired.map((x) => x.id), [e.id]);
  assert.equal(net.prepared.length, 0);
});

test("a transient failure waits out its backoff before the next send", async () => {
  const e = entry();
  const store = memoryStore([e]);
  const net = network(store, { send: () => ({ kind: "rejected", err: "BlockhashNotFound" }) });

  await settleOnce(store, net.deps);
  await settleOnce(store, net.deps);
  assert.equal(net.prepared.length, 1, "not before the backoff");

  net.advance(DEFAULT_POLICY.transientBaseMs);
  await settleOnce(store, net.deps);
  assert.equal(net.prepared.length, 2);
});

test("the round stops at the first unreachable send", async () => {
  const store = memoryStore([entry({ seq: 1n }), entry({ seq: 2n }), entry({ seq: 3n })]);
  const net = network(store, { send: () => ({ kind: "unreachable", message: "down" }) });

  const r = await settleOnce(store, net.deps);
  assert.equal(r.offline, true);
  assert.equal(net.prepared.length, 1);
});

test("a relayer that declines, retryably, leaves the voucher pending with nothing in flight", async () => {
  const e = entry();
  const store = memoryStore([e]);
  let clock = T0;
  const deps: SettleDeps = {
    now: () => clock,
    prepare: async () => ({ declined: { RelayDeclined: { reason: "the relayer's budget for this window is spent", retryable: true } } }),
    statuses: async () => new Map(),
  };
  const r = await settleOnce(store, deps);
  assert.equal(r.offline, false, "a refusal is not the network being down");
  const after = store.get(e.id)!;
  assert.equal(after.status, "pending");
  assert.deepEqual(after.inFlight, []);
  assert.equal(after.verdict?.reason, "relay-declined");
  assert.ok(after.nextAttemptAt > clock, "and waits before asking again");
  clock += 1;
});

test("a relayer that refuses outright holds the voucher for a person", async () => {
  const e = entry();
  const store = memoryStore([e]);
  const deps: SettleDeps = {
    now: () => T0,
    prepare: async () => ({ declined: { RelayDeclined: { reason: "voucher has expired", retryable: false } } }),
    statuses: async () => new Map(),
  };
  const r = await settleOnce(store, deps);
  assert.deepEqual(r.held.map((x) => x.id), [e.id]);
});
