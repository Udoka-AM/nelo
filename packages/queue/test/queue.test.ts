/**
 * The queue's rules, one at a time. The ones that matter most are about the
 * merchant's own attempts: a redemption that landed but was lost track of
 * must never be read back as a double spend.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeBase58 } from "@nelo/voucher";
import {
  DEFAULT_POLICY,
  dropped,
  enqueue,
  expire,
  failed,
  fromRecord,
  landed,
  outstanding,
  plan,
  release,
  sent,
  toRecord,
  unreachable,
  type Entry,
} from "../src/index.ts";
import { entry, EXPIRES, onRedeem, packet, T0 } from "./fixtures.ts";

// ---- enqueue ----

test("a new voucher is added with its fields decoded", () => {
  const e = entry({ seq: 7n, amount: 12_500_000n });
  assert.equal(e.id, `${encodeBase58(new Uint8Array(32).fill(0x11))}:7`);
  assert.equal(e.seq, 7n);
  assert.equal(e.amount, 12_500_000n);
  assert.equal(e.expiresAt, EXPIRES);
  assert.equal(e.status, "pending");
  assert.equal(e.nextAttemptAt, T0, "due at once");
});

test("the same bytes twice is a duplicate, not a second entry", () => {
  const first = entry();
  const r = enqueue((id) => (id === first.id ? first : undefined), packet(), T0 + 5);
  assert.equal(r.kind, "duplicate");
});

test("the same message with a different signature is a duplicate, not a conflict", () => {
  // A payer's phone re-signs the same message after a crash, and ECDSA gives a
  // new signature. Calling that a conflict would accuse the payer of fraud.
  const first = entry();
  const resigned = packet();
  resigned[105] ^= 0xff;
  const r = enqueue((id) => (id === first.id ? first : undefined), resigned, T0 + 5);
  assert.equal(r.kind, "duplicate");
});

test("different bytes at a held sequence are a conflict, with both packets kept", () => {
  const first = entry({ amount: 5_000_000n });
  const other = packet({ amount: 9_000_000n });
  const r = enqueue((id) => (id === first.id ? first : undefined), other, T0 + 5);
  assert.equal(r.kind, "conflict");
  if (r.kind === "conflict") {
    assert.deepEqual(r.existing.packet, first.packet);
    assert.deepEqual(r.incoming, other);
  }
});

test("bytes that are not a voucher throw at the door", () => {
  assert.throws(() => enqueue(() => undefined, new Uint8Array(201), T0), /202 bytes/);
});

test("the queue keeps its own copy of the packet", () => {
  const bytes = packet();
  const r = enqueue(() => undefined, bytes, T0);
  bytes[0] = 99;
  assert.equal((r as { entry: Entry }).entry.packet[0], 1);
});

// ---- plan ----

test("a due entry is submitted; one not yet due waits", () => {
  const due = entry({ seq: 1n });
  const later = { ...entry({ seq: 2n }), nextAttemptAt: T0 + 60_000 };
  const p = plan([due, later], T0);
  assert.deepEqual(p.submit.map((e) => e.seq), [1n]);
});

test("an entry with an attempt in flight is looked up, never resent", () => {
  const e = sent(entry(), "sigA", T0);
  const p = plan([e], T0 + 10 * 60_000);
  assert.deepEqual(p.check, [e]);
  assert.deepEqual(p.submit, []);
  assert.deepEqual(p.expire, []);
});

test("expiry waits out the grace, because the chain's clock is the one that counts", () => {
  const e = entry({ expiresAt: BigInt(T0 / 1000) });
  const graceMs = DEFAULT_POLICY.expiryGraceSeconds * 1000;
  assert.deepEqual(plan([e], T0 + graceMs).submit, [e], "still tried inside the grace");
  assert.deepEqual(plan([e], T0 + graceMs + 1000).expire, [e], "given up after it");
});

test("submission order: earliest expiry first, then each payer's lowest sequence", () => {
  const soon = entry({ vault: 0x33, seq: 9n, expiresAt: EXPIRES - 100n });
  const a2 = entry({ vault: 0x11, seq: 2n });
  const a1 = entry({ vault: 0x11, seq: 1n });
  const p = plan([a2, soon, a1], T0);
  assert.deepEqual(
    p.submit.map((e) => e.id),
    [soon.id, a1.id, a2.id],
  );
});

test("a round sends at most the policy's maximum", () => {
  const many = Array.from({ length: 9 }, (_, i) => entry({ seq: BigInt(i + 1) }));
  assert.equal(plan(many, T0).submit.length, DEFAULT_POLICY.maxSubmitPerRound);
});

test("only pending entries are planned", () => {
  const e = entry();
  const done = landed(sent(e, "s", T0), "s", T0);
  const held = failed(sent(entry({ seq: 2n }), "t", T0), "t", onRedeem("MintMismatch"), T0);
  const p = plan([done, held], T0 + 1e9);
  assert.deepEqual([p.check, p.submit, p.expire], [[], [], []]);
});

// ---- outcomes ----

test("a signature is recorded as an attempt, once", () => {
  const e = sent(entry(), "sigA", T0 + 1);
  assert.equal(e.attempts, 1);
  assert.deepEqual(e.inFlight, [{ signature: "sigA", sentAt: T0 + 1 }]);
  assert.equal(sent(e, "sigA", T0 + 2), e, "idempotent");
});

test("a confirmed attempt settles the entry", () => {
  const e = landed(sent(entry(), "sigA", T0), "sigA", T0 + 5);
  assert.equal(e.status, "settled");
  assert.equal(e.settledSignature, "sigA");
  assert.deepEqual(e.inFlight, []);
});

test("already-redeemed with nothing else of ours out there is a loss", () => {
  const e = failed(sent(entry(), "sigA", T0), "sigA", onRedeem("SequenceAlreadyRedeemed"), T0 + 5);
  assert.equal(e.status, "refused");
  assert.equal(e.verdict?.reason, "paid-to-someone-else");
});

test("already-redeemed while our own earlier attempt is unaccounted for is not believed yet", () => {
  // A went out and we lost track; B then says the sequence is taken. A may be
  // what took it.
  let e = sent(entry(), "sigA", T0);
  e = sent(e, "sigB", T0 + 1);
  e = failed(e, "sigB", onRedeem("SequenceAlreadyRedeemed"), T0 + 2);
  assert.equal(e.status, "pending");
  assert.equal(e.awaitingOwnAttempts, true);
  assert.deepEqual(e.inFlight.map((a) => a.signature), ["sigA"]);

  // And A did land: the merchant was paid.
  const paid = landed(e, "sigA", T0 + 3);
  assert.equal(paid.status, "settled");
  assert.equal(paid.awaitingOwnAttempts, false);
});

test("…and if our own attempt never landed, it was somebody else", () => {
  let e = sent(entry(), "sigA", T0);
  e = sent(e, "sigB", T0 + 1);
  e = failed(e, "sigB", onRedeem("SequenceAlreadyRedeemed"), T0 + 2);
  e = dropped(e, "sigA", T0 + 3);
  assert.equal(e.status, "refused");
  assert.equal(e.verdict?.reason, "paid-to-someone-else");
});

test("a dropped attempt with no verdict pending is simply sent again", () => {
  const e = dropped(sent(entry(), "sigA", T0), "sigA", T0 + 200_000);
  assert.equal(e.status, "pending");
  assert.deepEqual(e.inFlight, []);
  assert.equal(e.nextAttemptAt, T0 + 200_000);
});

test("transient failures back off exponentially, up to the cap", () => {
  let e = entry();
  const waits: number[] = [];
  for (let i = 0; i < 8; i++) {
    const at = T0 + i;
    e = failed(sent(e, `s${i}`, at), `s${i}`, "BlockhashNotFound", at);
    waits.push(e.nextAttemptAt - at);
  }
  const base = DEFAULT_POLICY.transientBaseMs;
  assert.deepEqual(waits.slice(0, 3), [base, base * 2, base * 4]);
  assert.equal(waits.at(-1), DEFAULT_POLICY.transientCapMs);
  assert.equal(e.status, "pending");
});

test("blocked failures wait longer than transient ones", () => {
  const blocked = failed(sent(entry(), "s", T0), "s", onRedeem("InsufficientCollateral"), T0);
  const transient = failed(sent(entry(), "s", T0), "s", "BlockhashNotFound", T0);
  assert.equal(blocked.status, "pending");
  assert.equal(blocked.nextAttemptAt - T0, DEFAULT_POLICY.blockedBaseMs);
  assert.ok(blocked.nextAttemptAt > transient.nextAttemptAt);
});

test("a misbuilt transaction is held, and a person can release it", () => {
  const held = failed(sent(entry(), "s", T0), "s", onRedeem("MintMismatch"), T0);
  assert.equal(held.status, "held");
  assert.equal(held.verdict?.reason, "misbuilt");
  const again = release(held, T0 + 9);
  assert.equal(again.status, "pending");
  assert.equal(again.nextAttemptAt, T0 + 9);
  assert.throws(() => release(again, T0), /not held/);
});

test("already-processed keeps the attempt in flight to be looked up", () => {
  const e = failed(sent(entry(), "sigA", T0), "sigA", "AlreadyProcessed", T0 + 1);
  assert.equal(e.status, "pending");
  assert.deepEqual(e.inFlight.map((a) => a.signature), ["sigA"]);
});

test("an unreachable send stays in flight", () => {
  const e = unreachable(sent(entry(), "sigA", T0), "timeout", T0 + 1);
  assert.deepEqual(e.inFlight.map((a) => a.signature), ["sigA"]);
  assert.equal(e.verdict?.reason, "network");
});

test("nothing expires with an attempt still in flight", () => {
  assert.throws(() => expire(sent(entry(), "s", T0), T0), /in flight/);
  assert.equal(expire(entry(), T0).status, "expired");
});

test("outcomes for an entry that is no longer pending are refused loudly", () => {
  const done = landed(sent(entry(), "s", T0), "s", T0);
  assert.throws(() => failed(done, "s", "BlockhashNotFound", T0), /settled, not pending/);
  assert.throws(() => sent(done, "t", T0), /settled, not pending/);
});

test("outstanding counts what is still owed, and what is waiting on a person", () => {
  const a = entry({ seq: 1n, amount: 3n });
  const b = failed(sent(entry({ seq: 2n, amount: 5n }), "s", T0), "s", onRedeem("MintMismatch"), T0);
  const c = landed(sent(entry({ seq: 3n, amount: 7n }), "s", T0), "s", T0);
  assert.deepEqual(outstanding([a, b, c]), { pending: 3n, held: 5n });
});

test("an entry survives the round trip to storage exactly", () => {
  let e = sent(entry({ seq: 2n ** 63n, amount: 2n ** 64n - 1n }), "sigA", T0);
  e = failed(e, "sigA", onRedeem("AboveFloorLimit"), T0 + 1);
  const json = JSON.parse(JSON.stringify(toRecord(e)));
  assert.deepEqual(fromRecord(json), e);
});
