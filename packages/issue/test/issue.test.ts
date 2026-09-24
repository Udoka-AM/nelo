/**
 * Issuing. The property that matters above all is in the last group: under
 * crashes and failed signatures at every point, no sequence is ever signed
 * over two different messages — because that pair freezes the payer's vault.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { p256 } from "@noble/curves/p256";
import { accept, type Enrolment } from "@nelo/accept";
import { decode, encodeBase58, signedMessage, verify } from "@nelo/voucher";
import {
  applyChain,
  complete,
  initialState,
  pay,
  pendingMessage,
  prepare,
  resume,
  spendable,
  WITHDRAW_TIMELOCK_SECONDS,
  type ChainView,
  type IssuerState,
  type IssuerStore,
  type Sign,
} from "../src/index.ts";

const NOW = 1_789_000_000;
const VAULT = encodeBase58(new Uint8Array(32).fill(0x11));
const MERCHANT = encodeBase58(new Uint8Array(32).fill(0x22));
const SALT = new Uint8Array(8).fill(7);
const SK = p256.utils.randomPrivateKey();
const PUB = p256.getPublicKey(SK, true);

const signWith = (sk: Uint8Array): Sign => async (m) =>
  p256.sign(m, sk, { prehash: true, lowS: true }).toCompactRawBytes();

function chain(o: Partial<ChainView> = {}): ChainView {
  return {
    balance: 100_000_000n,
    seqBase: 0n,
    seqBitmap: 0n,
    unlockAt: 0n,
    status: 0,
    limit: 50_000_000n,
    syncedAt: NOW,
    ...o,
  };
}

function state(o: Partial<ChainView> = {}): IssuerState {
  return initialState(VAULT, PUB, chain(o));
}

const req = (amount: bigint, now = NOW) => ({ merchant: MERCHANT, amount, now });

function prepared(s: IssuerState, amount = 10_000_000n) {
  const p = prepare(s, req(amount), SALT);
  assert.ok(p.ok, p.ok ? "" : p.reason);
  return p as Extract<typeof p, { ok: true }>;
}

// ---- refusals ----

test("refused: nothing, a frozen vault, a pending withdrawal", () => {
  assert.match((prepare(state(), req(0n), SALT) as { reason: string }).reason, /more than zero/);
  assert.match((prepare(state({ status: 1 }), req(1n), SALT) as { reason: string }).reason, /frozen/);
  assert.match((prepare(state({ unlockAt: 5n }), req(1n), SALT) as { reason: string }).reason, /withdrawal is pending/);
});

test("refused: above the limit, and above what is left to promise", () => {
  assert.match((prepare(state(), req(50_000_001n), SALT) as { reason: string }).reason, /offline limit/);
  let s = state({ balance: 15_000_000n });
  const first = prepared(s, 10_000_000n);
  s = (complete(first.state, p256.sign(first.message, SK, { prehash: true, lowS: true }).toCompactRawBytes()) as {
    state: IssuerState;
  }).state;
  assert.equal(spendable(s), 5_000_000n);
  assert.match((prepare(s, req(5_000_001n), SALT) as { reason: string }).reason, /Not enough left/);
  assert.ok(prepare(s, req(5_000_000n), SALT).ok, "exactly what is left is fine");
});

test("refused: a full replay window", () => {
  const s = { ...state(), nextSeq: 128n };
  assert.match((prepare(s, req(1n), SALT) as { reason: string }).reason, /Too many payments/);
  assert.ok(prepare({ ...s, nextSeq: 127n }, req(1n), SALT).ok, "the 128th slot is still usable");
});

test("refused: a second voucher while one is pending", () => {
  const p = prepared(state());
  assert.match((prepare(p.state, req(1n), SALT) as { reason: string }).reason, /already being signed/);
});

test("refused: a merchant that is not an address", () => {
  assert.match((prepare(state(), { ...req(1n), merchant: "abc" }, SALT) as { reason: string }).reason, /merchant address/);
});

test("a voucher may not outlive the withdrawal timelock", () => {
  assert.throws(() => prepare(state(), req(1n), SALT, { ttlSeconds: WITHDRAW_TIMELOCK_SECONDS }), /timelock/);
});

// ---- the voucher's fields ----

test("prepare fixes every field and advances the counter", () => {
  const p = prepared(state({ seqBase: 4n, seqBitmap: 0b101n }), 10_000_000n);
  assert.equal(p.fields.seq, 7n, "one past the highest redeemed: base 4, bits 0 and 2 set");
  assert.equal(p.state.nextSeq, 8n);
  assert.equal(p.fields.remainingAfter, 90_000_000n);
  assert.equal(p.fields.expiresAt, BigInt(NOW + 12 * 3600));
  assert.deepEqual(p.fields.salt, SALT);
  assert.deepEqual(p.message, signedMessage(p.fields));
  assert.deepEqual(pendingMessage(p.state), p.message);
});

test("a completed voucher verifies, and is recorded as outstanding", () => {
  const p = prepared(state());
  const c = complete(p.state, p256.sign(p.message, SK, { prehash: true, lowS: true }).toCompactRawBytes());
  assert.ok(c.ok);
  if (!c.ok) return;
  assert.ok(verify(decode(c.packet)));
  assert.equal(c.state.pending, null);
  assert.deepEqual(c.state.outstanding.map((o) => o.seq), [0n]);
});

test("a signature by another key, or high-S, is refused and the voucher stays pending", () => {
  const p = prepared(state());
  const wrong = complete(p.state, p256.sign(p.message, p256.utils.randomPrivateKey(), { prehash: true }).toCompactRawBytes());
  assert.equal(wrong.ok, false);

  const sig = p256.sign(p.message, SK, { prehash: true, lowS: true });
  const high = new p256.Signature(sig.r, p256.CURVE.n - sig.s).toCompactRawBytes();
  const h = complete(p.state, high);
  assert.equal(h.ok, false);
  if (!h.ok) assert.match(h.reason, /high-S/);
});

// ---- the chain ----

test("a sync drops redeemed and expired vouchers, and frees their amounts", () => {
  let s = state();
  for (const amount of [1n, 2n, 3n]) {
    const p = prepared(s, amount);
    s = (complete(p.state, p256.sign(p.message, SK, { prehash: true, lowS: true }).toCompactRawBytes()) as {
      state: IssuerState;
    }).state;
  }
  // Seq 0 redeemed (bit 0), seq 1 still out; seq 2 expired unredeemed.
  s = { ...s, outstanding: s.outstanding.map((o) => (o.seq === 2n ? { ...o, expiresAt: BigInt(NOW) } : o)) };
  const after = applyChain(s, chain({ balance: 99_999_999n, seqBitmap: 1n, syncedAt: NOW + 1 }));
  assert.deepEqual(after.outstanding.map((o) => o.seq), [1n]);
  assert.equal(spendable(after), 99_999_999n - 2n);
});

test("the counter never moves backwards, and catches up with the chain", () => {
  const s = { ...state(), nextSeq: 10n };
  assert.equal(applyChain(s, chain({ seqBase: 3n, syncedAt: NOW + 1 })).nextSeq, 10n);
  assert.equal(applyChain(s, chain({ seqBase: 20n, seqBitmap: 1n, syncedAt: NOW + 1 })).nextSeq, 21n);
});

test("an older read of the vault is ignored", () => {
  const s = state({ syncedAt: NOW + 10 });
  assert.equal(applyChain(s, chain({ balance: 1n, syncedAt: NOW })), s);
});

// ---- storage, signing, and crashes ----

function memoryStore(initial: IssuerState): IssuerStore & { current(): IssuerState } {
  let saved = initial;
  return {
    async load() {
      return saved;
    },
    async save(s) {
      saved = s;
    },
    current: () => saved,
  };
}

const random = (n: number) => new Uint8Array(n).fill(9);

test("the fixed voucher is saved before anything is signed", async () => {
  const store = memoryStore(state());
  const sign: Sign = async (m) => {
    assert.deepEqual(pendingMessage(store.current()), m, "on disk before the key is used");
    return signWith(SK)(m);
  };
  const r = await pay(store, sign, req(1_000_000n), random);
  assert.ok(r.ok);
});

test("a failed signature leaves the payment pending, and resume signs the same bytes", async () => {
  const store = memoryStore(state());
  const signed: Uint8Array[] = [];
  let fail = true;
  const sign: Sign = async (m) => {
    signed.push(m);
    if (fail) throw new Error("cancelled at the prompt");
    return signWith(SK)(m);
  };

  const first = await pay(store, sign, req(1_000_000n), random);
  assert.equal(first.ok, false);
  assert.equal((first as { unfinished?: boolean }).unfinished, true);

  const blocked = await pay(store, sign, req(2_000_000n), random);
  assert.equal(blocked.ok, false, "no new voucher while one is unfinished");

  fail = false;
  const resumed = await resume(store, sign);
  assert.ok(resumed.ok);
  assert.deepEqual(signed[0], signed[1], "the same message, not a new one at the same sequence");
  assert.equal(decode((resumed as { packet: Uint8Array }).packet).amount, 1_000_000n);
});

test("under failures and restarts at every point, no sequence is ever signed over two messages", async () => {
  // Deterministic pseudo-randomness, so a failure reproduces.
  let x = 12345;
  const rand = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  const store = memoryStore(state({ balance: 10n ** 12n, limit: 10n ** 12n }));
  const bySeq = new Map<bigint, string>();
  const sign: Sign = async (m) => {
    const seq = new DataView(m.buffer, m.byteOffset).getBigUint64(33, true);
    const hex = Buffer.from(m).toString("hex");
    const before = bySeq.get(seq);
    assert.ok(before === undefined || before === hex, `sequence ${seq} signed over two different messages`);
    bySeq.set(seq, hex);
    if (rand() < 0.3) throw new Error("keystore hiccup");
    return signWith(SK)(m);
  };
  const salt = (n: number) => Uint8Array.from({ length: n }, () => Math.floor(rand() * 256));

  let issued = 0;
  for (let i = 0; i < 300; i++) {
    // A "restart" is simply the next call reloading from the store: nothing
    // survives in memory between iterations.
    const r = (await store.load())!.pending
      ? await resume(store, sign)
      : await pay(store, sign, req(BigInt(1 + Math.floor(rand() * 1000))), salt);
    if (r.ok) issued++;
    if (store.current().nextSeq - store.current().chain.seqBase >= 120n) {
      // Pretend a sync saw everything redeemed, so the window keeps moving.
      const s = store.current();
      await store.save(applyChain(s, { ...s.chain, seqBase: s.nextSeq, seqBitmap: 0n, syncedAt: s.chain.syncedAt + 1 }));
    }
  }
  assert.ok(issued > 150, `only ${issued} issued — the test barely exercised anything`);
});

// ---- the other side of the counter ----

test("a merchant's offline check takes what this issuer produces", async () => {
  const store = memoryStore(state());
  const r = await pay(store, signWith(SK), req(10_000_000n), random);
  assert.ok(r.ok);
  if (!r.ok) return;
  const enrolment: Enrolment = {
    vault: VAULT,
    devicePubkey: PUB,
    mint: encodeBase58(new Uint8Array(32).fill(0x55)),
    balance: 100_000_000n,
    floorLimit: 50_000_000n,
    stake: 0n,
    pendingUnstake: 0n,
    reputationBps: 10_000,
    seqBase: 0n,
    seqBitmap: 0n,
    status: 0,
    syncedAt: NOW,
  };
  const decision = accept({
    bytes: r.packet,
    enrolment,
    risk: { kBps: 0, stakeReference: 1n, hardCap: 10n ** 12n, stakePrice: 0n, haircutBps: 0 },
    now: NOW,
  });
  assert.equal(decision.take, true, decision.take ? "" : decision.reason);
});
