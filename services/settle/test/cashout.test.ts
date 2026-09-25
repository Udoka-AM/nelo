/**
 * Cash-outs, against a fake partner. What matters: one cash-out id is one
 * order and one transfer, the record exists before anyone is asked anything,
 * and the state only moves forward, whatever a webhook or a lagging API says.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  byReference,
  markFunded,
  memoryCashouts,
  openCashout,
  refresh,
  type CashoutPartner,
  type PartnerStatus,
} from "../src/index.ts";

const MERCHANT = "Merch4nt1111111111111111111111111111111111";
const DEST = "bank:NG:058:0123456789";
const SIG = "5".repeat(87);
const NOW = Date.parse("2026-09-25T10:00:00Z");

function partner(o: { refuse?: string; fund?: bigint; throws?: boolean; status?: PartnerStatus } = {}) {
  const asked: string[] = [];
  let n = 0;
  const p: CashoutPartner & { asked: string[]; next: PartnerStatus } = {
    name: "paj",
    asked,
    next: o.status ?? { state: "awaiting-funds", detail: "waiting" },
    async disburse(r) {
      asked.push(r.payoutId);
      const store = current;
      assert.ok(store?.read().cashouts[r.payoutId], "the cash-out is on disk before the partner is asked");
      if (o.throws) throw new Error("socket hang up");
      if (o.refuse) return { status: "rejected", partner: "paj", fidelity: "sandbox", reason: o.refuse };
      n++;
      return {
        status: "accepted",
        partner: "paj",
        fidelity: "sandbox",
        partnerReference: `ord_${n}`,
        funding: { address: `Dep${n}`, mint: "USDC", tokenMinor: o.fund ?? r.tokenMinor, localMinor: 3_812_500n },
      };
    },
    async status() {
      return p.next;
    },
  };
  return p;
}

let current: ReturnType<typeof memoryCashouts> | null = null;
function deps(p: CashoutPartner, perDay = 5) {
  current = current ?? memoryCashouts();
  return { store: current, partner: p, now: NOW, tokenCurrency: "USDC", localCurrency: "NGN", limits: { perMerchantPerDay: perDay, minTokenMinor: 1_000_000n } };
}
const fresh = () => void (current = memoryCashouts());
const req = (id = "co_000001", tokenMinor = 25_000_000n) => ({ id, merchant: MERCHANT, destination: DEST, tokenMinor });

test("a cash-out opens one order and says where to send the USDC", async () => {
  fresh();
  const p = partner();
  const r = await openCashout(req(), deps(p));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.cashout.state, "awaiting-funds");
  assert.equal(r.cashout.reference, "ord_1");
  assert.equal(r.cashout.deposit, "Dep1");
  assert.equal(r.cashout.fundMinor, "25000000");
  assert.equal(r.cashout.localMinor, "3812500");
});

test("asked again with the same id: the same order, and the partner is not asked twice", async () => {
  fresh();
  const p = partner();
  const a = await openCashout(req(), deps(p));
  const b = await openCashout(req(), deps(p));
  assert.deepEqual(b, a);
  assert.deepEqual(p.asked, ["co_000001"]);
  // The same id for a different cash-out is refused, not quietly merged.
  const other = await openCashout(req("co_000001", 1_000_000n), deps(p));
  assert.equal(other.ok, false);
});

test("a crash between recording and the partner's answer asks again, opening at most one more unfunded order", async () => {
  fresh();
  const down = partner({ throws: true });
  await assert.rejects(openCashout(req(), deps(down)));
  assert.equal(current!.file().cashouts["co_000001"]!.state, "creating");
  const up = partner();
  const r = await openCashout(req(), deps(up));
  assert.ok(r.ok && r.cashout.state === "awaiting-funds");
});

test("a refusal fails the cash-out with the partner's reason", async () => {
  fresh();
  const r = await openCashout(req(), deps(partner({ refuse: "account name mismatch" })));
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.cashout.state, "failed");
    assert.equal(r.cashout.detail, "account name mismatch");
    assert.equal(r.cashout.deposit, null, "nowhere to send anything");
  }
});

test("a partner that asks for less than is being cashed out is not funded", async () => {
  fresh();
  const r = await openCashout(req(), deps(partner({ fund: 24_000_000n })));
  assert.ok(r.ok && r.cashout.state === "failed" && r.cashout.deposit === null);
});

test("funding is recorded once, and only by the transfer that did it", async () => {
  fresh();
  const p = partner();
  await openCashout(req(), deps(p));
  assert.ok(markFunded("co_000001", SIG, { store: current!, now: NOW }).ok);
  assert.ok(markFunded("co_000001", SIG, { store: current!, now: NOW }).ok, "the same report again is fine");
  assert.equal(markFunded("co_000001", "4".repeat(87), { store: current!, now: NOW }).ok, false);
  assert.equal(markFunded("nope_0000", SIG, { store: current!, now: NOW }).ok, false);
  // A failed cash-out has nowhere to be funded.
  fresh();
  await openCashout(req(), deps(partner({ refuse: "no" })));
  assert.equal(markFunded("co_000001", SIG, { store: current!, now: NOW }).ok, false);
});

test("the state only moves forward: a lagging INIT does not undo funded, and paid is final", async () => {
  fresh();
  const p = partner();
  await openCashout(req(), deps(p));
  markFunded("co_000001", SIG, { store: current!, now: NOW });
  p.next = { state: "awaiting-funds", detail: "waiting for the USDC to arrive" };
  assert.equal((await refresh("co_000001", deps(p)))!.state, "funded");
  p.next = { state: "processing", detail: "paying the bank" };
  assert.equal((await refresh("co_000001", deps(p)))!.state, "processing");
  p.next = { state: "paid", detail: "paid" };
  assert.equal((await refresh("co_000001", deps(p)))!.state, "paid");
  p.next = { state: "failed", detail: "late nonsense" };
  assert.equal((await refresh("co_000001", deps(p)))!.state, "paid");
});

test("a failure after funding says where the USDC went, so it can be chased", async () => {
  fresh();
  const p = partner();
  await openCashout(req(), deps(p));
  markFunded("co_000001", SIG, { store: current!, now: NOW });
  p.next = { state: "failed", detail: "paj.cash marked it failed" };
  const c = await refresh("co_000001", deps(p));
  assert.equal(c!.state, "failed");
  assert.match(c!.detail, new RegExp(SIG));
});

test("an unknown partner state is reported and changes nothing", async () => {
  fresh();
  const p = partner();
  await openCashout(req(), deps(p));
  p.next = { state: null, detail: 'paj.cash reports "ON_HOLD"' };
  const c = await refresh("co_000001", deps(p));
  assert.equal(c!.state, "awaiting-funds");
  assert.match(c!.detail, /ON_HOLD/);
});

test("a webhook finds its cash-out by the partner's reference", async () => {
  fresh();
  await openCashout(req(), deps(partner()));
  assert.equal(byReference(current!, "ord_1")!.id, "co_000001");
  assert.equal(byReference(current!, "ord_9"), null);
});

test("limits: a daily count per merchant, a smallest amount, and a sane id", async () => {
  fresh();
  const p = partner();
  assert.ok((await openCashout(req("co_000001"), deps(p, 1))).ok);
  const second = await openCashout(req("co_000002"), deps(p, 1));
  assert.equal(second.ok, false);
  assert.equal((await openCashout(req("co_000003", 999_999n), deps(p))).ok, false);
  assert.equal((await openCashout(req("../x"), deps(p))).ok, false);
});
