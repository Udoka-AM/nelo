/**
 * The settlement service end to end: HTTP in, the real partner and client,
 * a fake paj.cash v2 behind them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { buildSettle, memoryCashouts, pajClient, PajPartner, PAJ_API } from "../src/index.ts";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MERCHANT = "Merch4nt1111111111111111111111111111111111";
const NOW = Date.parse("2026-10-05T10:00:00Z");
const SIG = "5".repeat(87);
const WHSEC = "whsec_test";
const DEST = "bank:NG:000013:0123456789";

function world(o: { keyRefused?: boolean; signed?: boolean } = {}) {
  let status = "INIT";
  let calls = 0;
  const asked: string[] = [];
  const f = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const path = url.slice(PAJ_API.length);
    asked.push(`${init?.method ?? "GET"} ${path.split("?")[0]}`);
    const reply = (body: unknown, s = 200) => ({ ok: s < 300, status: s, text: async () => JSON.stringify(body) });
    if (o.keyRefused) return reply({ statusCode: 401, message: "Invalid API key", error: "Unauthorized" }, 401);
    if (path === "/pub/v2/rate?currency=NGN") return reply({ offRampRate: { targetCurrency: "NGN", rate: 1610 } });
    if (path === "/pub/v2/bank?country=NG") return reply([{ id: "b-gt", code: "000013", name: "GTBank", country: "NG" }]);
    if (path === "/pub/v2/bank-account" && init?.method === "POST") {
      const b = JSON.parse(init.body ?? "{}") as { bankCode: string; accountNumber: string };
      if (b.accountNumber === "0000000000") return reply({ statusCode: 400, message: "Account could not be resolved", error: "Bad Request" }, 400);
      return reply({ id: "acct_1", accountName: "ADAEZE OKAFOR", accountNumber: b.accountNumber, bank: "GTBank", address: "Standing" });
    }
    if (path === "/pub/v2/offramp") {
      // Slow enough that two requests really overlap.
      await new Promise((r) => setTimeout(r, 25));
      calls++;
      return reply({ id: `ord_${calls}`, address: "Dep", mint: USDC, currency: "NGN", amount: 25, fiatAmount: 40250, rate: 1610, status: "INIT" });
    }
    if (path.startsWith("/pub/v2/transaction/")) return reply({ id: "ord_1", status, transactionType: "OFF_RAMP" });
    return reply({ statusCode: 404, message: "Not Found" }, 404);
  };
  const store = memoryCashouts();
  const partner = new PajPartner({
    client: pajClient({ apiKey: "k", fetch: f }),
    mint: USDC,
    tokenDecimals: 6,
    localCurrency: "NGN",
    localDigits: 2,
    webhookURL: "https://settle.example/v1/paj/webhook/hook-secret",
    now: () => NOW,
  });
  const app = buildSettle({
    partner,
    store,
    now: () => NOW,
    token: "app-token",
    webhookSecret: "hook-secret",
    ...(o.signed === false ? {} : { pajSigningSecret: WHSEC }),
    tokenCurrency: "USDC",
    localCurrency: "NGN",
    limits: { perMerchantPerDay: 5, minTokenMinor: 500_000n },
  });
  const auth = { authorization: "Bearer app-token" };
  /** A delivery as paj.cash signs it. */
  const hook = (body: unknown, opts: { at?: number; secret?: string } = {}) => {
    const payload = JSON.stringify(body);
    const ts = String(Math.floor((opts.at ?? NOW) / 1000));
    const sig = createHmac("sha256", opts.secret ?? WHSEC).update(`${ts}.${payload}`).digest("hex");
    return app.inject({
      method: "POST",
      url: "/v1/paj/webhook/hook-secret",
      headers: { "content-type": "application/json", "x-paj-timestamp": ts, "x-paj-signature": `v1=${sig}` },
      payload,
    });
  };
  return { app, auth, store, asked, hook, setStatus: (s: string) => void (status = s), offramps: () => calls };
}

test("the app needs its token; health and the webhook do not", async () => {
  const w = world();
  assert.equal((await w.app.inject({ method: "GET", url: "/v1/rate" })).statusCode, 401);
  const health = await w.app.inject({ method: "GET", url: "/v1/health" });
  assert.deepEqual(health.json(), { partner: "paj", fidelity: "live" });
  assert.equal((await w.hook({ id: "ord_x" })).statusCode, 200);
});

test("the rate is paj.cash's, as exact integers, and fetched once a minute", async () => {
  const w = world();
  const r = await w.app.inject({ method: "GET", url: "/v1/rate", headers: w.auth });
  assert.deepEqual(r.json(), { partner: "paj", fidelity: "live", currency: "NGN", rate: "1610", localPerToken: "161000", scale: 6, at: NOW });
  await w.app.inject({ method: "GET", url: "/v1/rate", headers: w.auth });
  assert.equal(w.asked.filter((a) => a === "GET /pub/v2/rate").length, 1);
});

test("banks, and whose account a number is, before a merchant saves it", async () => {
  const w = world();
  const banks = await w.app.inject({ method: "GET", url: "/v1/banks", headers: w.auth });
  assert.deepEqual(banks.json(), [{ code: "000013", name: "GTBank" }]);
  const who = await w.app.inject({ method: "GET", url: "/v1/banks/000013/accounts/0123456789", headers: w.auth });
  assert.deepEqual(who.json(), { accountName: "ADAEZE OKAFOR", bank: "GTBank" });
  assert.equal((await w.app.inject({ method: "GET", url: "/v1/banks/000013/accounts/0000000000", headers: w.auth })).statusCode, 404);
  assert.equal((await w.app.inject({ method: "GET", url: "/v1/banks/999992/accounts/0123456789", headers: w.auth })).statusCode, 404);
  assert.equal((await w.app.inject({ method: "GET", url: "/v1/banks/000013/accounts/12", headers: w.auth })).statusCode, 400);
});

test("a cash-out end to end: open, fund, and paj.cash's own answer moves it on", async () => {
  const w = world();
  const body = { id: "co_000001", merchant: MERCHANT, destination: DEST, amount: "25000000" };
  const opened = await w.app.inject({ method: "POST", url: "/v1/cashouts", headers: w.auth, payload: body });
  assert.equal(opened.statusCode, 200);
  assert.equal(opened.json().state, "awaiting-funds");
  assert.equal(opened.json().deposit, "Dep");
  assert.equal(opened.json().fundMinor, "25000000");
  assert.equal(opened.json().localMinor, "4025000");
  // The same request again: the same order, and paj.cash asked once.
  const again = await w.app.inject({ method: "POST", url: "/v1/cashouts", headers: w.auth, payload: body });
  assert.deepEqual(again.json(), opened.json());
  assert.equal(w.offramps(), 1);

  const funded = await w.app.inject({ method: "POST", url: "/v1/cashouts/co_000001/funded", headers: w.auth, payload: { signature: SIG } });
  assert.equal(funded.json().state, "funded");

  // Even a signed webhook claiming it is done is only a prompt; paj.cash still says INIT.
  await w.hook({ id: "ord_1", status: "COMPLETED" });
  assert.equal(w.store.read().cashouts["co_000001"]!.state, "funded");
  w.setStatus("PROCESSING");
  await w.hook({ id: "ord_1" });
  assert.equal(w.store.read().cashouts["co_000001"]!.state, "processing");
  w.setStatus("COMPLETED");
  await w.hook({ id: "ord_1" });
  assert.equal(w.store.read().cashouts["co_000001"]!.state, "paid");
  const seen = await w.app.inject({ method: "GET", url: "/v1/cashouts/co_000001", headers: w.auth });
  assert.equal(seen.json().state, "paid");
});

test("two requests for one cash-out at once open one order", async () => {
  const w = world();
  const body = { id: "co_000001", merchant: MERCHANT, destination: DEST, amount: "25000000" };
  await Promise.all([
    w.app.inject({ method: "POST", url: "/v1/cashouts", headers: w.auth, payload: body }),
    w.app.inject({ method: "POST", url: "/v1/cashouts", headers: w.auth, payload: body }),
  ]);
  assert.equal(w.offramps(), 1);
});

test("webhooks: the wrong path secret is a 404; unsigned, forged, stale or tampered deliveries are refused", async () => {
  const w = world();
  assert.equal((await w.app.inject({ method: "POST", url: "/v1/paj/webhook/guess", payload: { id: "ord_1" } })).statusCode, 404);
  const unsigned = await w.app.inject({ method: "POST", url: "/v1/paj/webhook/hook-secret", payload: { id: "ord_1" } });
  assert.equal(unsigned.statusCode, 401);
  assert.equal((await w.hook({ id: "ord_1" }, { secret: "whsec_guess" })).statusCode, 401);
  assert.equal((await w.hook({ id: "ord_1" }, { at: NOW - 301_000 })).statusCode, 401);
  // A signature over different bytes: the body was altered in flight.
  const ts = String(Math.floor(NOW / 1000));
  const sig = createHmac("sha256", WHSEC).update(`${ts}.{"id":"ord_1"}`).digest("hex");
  const tampered = await w.app.inject({
    method: "POST",
    url: "/v1/paj/webhook/hook-secret",
    headers: { "content-type": "application/json", "x-paj-timestamp": ts, "x-paj-signature": `v1=${sig}` },
    payload: '{"id": "ord_1"}',
  });
  assert.equal(tampered.statusCode, 401);
  // Without a signing secret configured, the path secret alone admits it (local runs).
  const open = world({ signed: false });
  assert.equal((await open.app.inject({ method: "POST", url: "/v1/paj/webhook/hook-secret", payload: { id: "ord_1" } })).statusCode, 200);
});

test("a refused API key is a 503 for the operator, not a refusal: the cash-out is kept", async () => {
  const w = world({ keyRefused: true });
  const r = await w.app.inject({
    method: "POST",
    url: "/v1/cashouts",
    headers: w.auth,
    payload: { id: "co_000001", merchant: MERCHANT, destination: DEST, amount: "25000000" },
  });
  assert.equal(r.statusCode, 503);
  assert.equal(r.json().login, true);
  assert.equal(w.store.read().cashouts["co_000001"]!.state, "creating", "kept, to go through once the key is fixed");
});

test("bad input is a 400, and a refused cash-out says why", async () => {
  const w = world();
  assert.equal((await w.app.inject({ method: "POST", url: "/v1/cashouts", headers: w.auth, payload: { id: "x" } })).statusCode, 400);
  const small = await w.app.inject({
    method: "POST",
    url: "/v1/cashouts",
    headers: w.auth,
    payload: { id: "co_000002", merchant: MERCHANT, destination: DEST, amount: "10" },
  });
  assert.equal(small.statusCode, 422);
});
