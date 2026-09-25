/**
 * PajPartner over the real client, against a fake paj.cash.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { convert, memorySessionStore, currentSession, pajClient, PajPartner, PajError, PAJ_STAGING } from "../src/index.ts";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const NOW = Date.parse("2026-09-25T10:00:00Z");

function paj(script: Record<string, (body: any) => { status?: number; body: unknown }>) {
  const asked: { path: string; body: any }[] = [];
  const f = async (url: string, init?: { body?: string }) => {
    const path = url.slice(PAJ_STAGING.length).split("?")[0]!;
    const body = init?.body ? JSON.parse(init.body) : undefined;
    asked.push({ path, body });
    const key = Object.keys(script).find((k) => path.startsWith(k));
    const a = key ? script[key]!(body) : { status: 404, body: { message: "not found" } };
    return { ok: (a.status ?? 200) < 300, status: a.status ?? 200, text: async () => JSON.stringify(a.body) };
  };
  const store = memorySessionStore({ token: "tok", expiresAt: NOW + 3_600_000 });
  const partner = new PajPartner({
    client: pajClient({ baseUrl: PAJ_STAGING, apiKey: "k", fetch: f }),
    session: () => currentSession(store, NOW),
    fidelity: "sandbox",
    mint: USDC,
    tokenDecimals: 6,
    localCurrency: "NGN",
    localDigits: 2,
    webhookURL: "https://settle.example/v1/paj/webhook/s",
    now: () => NOW,
  });
  return { partner, asked, store };
}

const BANKS = { "/pub/bank": () => ({ body: [{ id: "b-gt", code: "058", name: "GTBank", country: "NG" }] }) };
const request = (destination = "bank:NG:058:0123456789") => ({
  payoutId: "co_000001",
  merchantId: "m",
  destination,
  tokenMinor: 25_000_000n,
  tokenCurrency: "USDC",
  localMinor: 0n,
  localCurrency: "NGN",
});

test("a quote is paj.cash's off-ramp rate, as the ledger's rate, labelled sandbox", async () => {
  const { partner } = paj({ "/pub/rate": () => ({ body: { offRampRate: { targetCurrency: "NGN", isActive: true, rate: 1525 } } }) });
  const q = await partner.quote("USDC", "NGN", NOW);
  assert.equal(q.fidelity, "sandbox");
  assert.equal(convert(1_000_000n, q.partnerRate), 152_500n);
});

test("a bank payout finds paj.cash's bank id from the central bank code, and returns where to send", async () => {
  const { partner, asked } = paj({
    ...BANKS,
    "/pub/offramp": () => ({ body: { id: "ord_1", address: "Dep", mint: USDC, currency: "NGN", amount: 25, fiatAmount: 38125, rate: 1525, fee: 0 } }),
  });
  const r = await partner.disburse(request());
  assert.deepEqual(r, {
    status: "accepted",
    partner: "paj",
    fidelity: "sandbox",
    partnerReference: "ord_1",
    funding: { address: "Dep", mint: USDC, tokenMinor: 25_000_000n, localMinor: 3_812_500n },
  });
  const order = asked.find((a) => a.path === "/pub/offramp")!.body;
  assert.equal(order.bank, "b-gt");
  assert.equal(order.accountNumber, "0123456789");
  assert.equal(order.amount, 25);
});

test("refused before paj.cash is asked: mobile money, a bank it does not list, a bad destination", async () => {
  const { partner, asked } = paj(BANKS);
  assert.equal((await partner.disburse(request("momo:NG:+2348031234567"))).status, "rejected");
  assert.equal((await partner.disburse(request("bank:NG:999:0123456789"))).status, "rejected");
  assert.equal((await partner.disburse(request("somewhere"))).status, "rejected");
  assert.ok(!asked.some((a) => a.path === "/pub/offramp"));
});

test("a 4xx from paj.cash is a refusal; a lapsed session is not, so the same cash-out can go through after login", async () => {
  const refused = paj({ ...BANKS, "/pub/offramp": () => ({ status: 400, body: { message: "Amount below minimum" } }) }).partner;
  const r = await refused.disburse(request());
  assert.equal(r.status, "rejected");
  if (r.status === "rejected") assert.match(r.reason, /below minimum/);
  const lapsed = paj({ ...BANKS, "/pub/offramp": () => ({ status: 401, body: { message: "Unauthorized" } }) }).partner;
  await assert.rejects(lapsed.disburse(request()), (e: unknown) => e instanceof PajError && e.session);
});

test("an expired session is caught before any request, with the fix in the message", async () => {
  const { partner, store, asked } = paj(BANKS);
  store.write({ token: "old", expiresAt: NOW + 30_000 });
  await assert.rejects(partner.banks(), /paj:login/);
  assert.equal(asked.length, 0);
});

test("paj.cash's order states map forward, and an unknown one changes nothing", async () => {
  let status = "INIT";
  const { partner } = paj({ "/pub/transactions/": () => ({ body: { id: "ord_1", status, transactionType: "OFF_RAMP" } }) });
  const states: (string | null)[] = [];
  for (const s of ["INIT", "PAID", "COMPLETED", "FAILED", "CANCELLED", "ON_HOLD"]) {
    status = s;
    states.push((await partner.status("ord_1")).state);
  }
  assert.deepEqual(states, ["awaiting-funds", "processing", "paid", "failed", "failed", null]);
});

test("the bank list is fetched once an hour, not per payout", async () => {
  const { partner, asked } = paj(BANKS);
  await partner.bankFor("058");
  await partner.bankFor("058");
  assert.equal(asked.filter((a) => a.path === "/pub/bank").length, 1);
});
