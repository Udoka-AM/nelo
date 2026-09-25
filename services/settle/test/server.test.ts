/**
 * The settlement service end to end: HTTP in, the real partner and client,
 * a fake paj.cash behind them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSettle,
  currentSession,
  memoryCashouts,
  memorySessionStore,
  pajClient,
  PajPartner,
  PAJ_STAGING,
} from "../src/index.ts";

const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const MERCHANT = "Merch4nt1111111111111111111111111111111111";
const NOW = Date.parse("2026-09-25T10:00:00Z");
const SIG = "5".repeat(87);

function world(o: { sessionExpired?: boolean } = {}) {
  let status = "INIT";
  let calls = 0;
  const asked: string[] = [];
  const f = async (url: string, init?: { method?: string; body?: string }) => {
    const path = url.slice(PAJ_STAGING.length);
    asked.push(`${init?.method ?? "GET"} ${path.split("?")[0]}`);
    const reply = (body: unknown, s = 200) => ({ ok: s < 300, status: s, text: async () => JSON.stringify(body) });
    if (path === "/pub/rate") return reply({ offRampRate: { targetCurrency: "NGN", isActive: true, rate: 1525 } });
    if (path === "/pub/bank") return reply([{ id: "b-gt", code: "058", name: "GTBank", country: "NG" }]);
    if (path.startsWith("/pub/bank-account/confirm")) {
      return path.includes("0000000000") ? reply({ message: "Account not found" }, 400) : reply({ accountName: "ADAEZE OKAFOR" });
    }
    if (path === "/pub/offramp") {
      // Slow enough that two requests really overlap.
      await new Promise((r) => setTimeout(r, 25));
      calls++;
      return reply({ id: `ord_${calls}`, address: "Dep", mint: USDC, currency: "NGN", amount: 25, fiatAmount: 38125, rate: 1525 });
    }
    if (path.startsWith("/pub/transactions/")) return reply({ id: "ord_1", status, transactionType: "OFF_RAMP" });
    return reply({ message: "not found" }, 404);
  };
  const sessions = memorySessionStore({ token: "tok", expiresAt: o.sessionExpired ? NOW : NOW + 3_600_000 });
  const store = memoryCashouts();
  const partner = new PajPartner({
    client: pajClient({ baseUrl: PAJ_STAGING, apiKey: "k", fetch: f }),
    session: () => currentSession(sessions, NOW),
    fidelity: "sandbox",
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
    tokenCurrency: "USDC",
    localCurrency: "NGN",
    limits: { perMerchantPerDay: 5, minTokenMinor: 1_000_000n },
  });
  const auth = { authorization: "Bearer app-token" };
  return { app, auth, store, asked, setStatus: (s: string) => void (status = s), offramps: () => calls };
}

test("the app needs its token; health and the webhook do not", async () => {
  const w = world();
  assert.equal((await w.app.inject({ method: "GET", url: "/v1/rate" })).statusCode, 401);
  assert.equal((await w.app.inject({ method: "GET", url: "/v1/health" })).statusCode, 200);
  const hook = await w.app.inject({ method: "POST", url: "/v1/paj/webhook/hook-secret", payload: { id: "ord_x" } });
  assert.equal(hook.statusCode, 200);
});

test("the rate is paj.cash's, as exact integers, and fetched once a minute", async () => {
  const w = world();
  const r = await w.app.inject({ method: "GET", url: "/v1/rate", headers: w.auth });
  assert.deepEqual(r.json(), { partner: "paj", fidelity: "sandbox", currency: "NGN", rate: "1525", localPerToken: "152500", scale: 6, at: NOW });
  await w.app.inject({ method: "GET", url: "/v1/rate", headers: w.auth });
  assert.equal(w.asked.filter((a) => a === "GET /pub/rate").length, 1);
});

test("banks, and whose account a number is, before a merchant saves it", async () => {
  const w = world();
  const banks = await w.app.inject({ method: "GET", url: "/v1/banks", headers: w.auth });
  assert.deepEqual(banks.json(), [{ code: "058", name: "GTBank" }]);
  const who = await w.app.inject({ method: "GET", url: "/v1/banks/058/accounts/0123456789", headers: w.auth });
  assert.deepEqual(who.json(), { accountName: "ADAEZE OKAFOR", bank: "GTBank" });
  assert.equal((await w.app.inject({ method: "GET", url: "/v1/banks/058/accounts/0000000000", headers: w.auth })).statusCode, 404);
  assert.equal((await w.app.inject({ method: "GET", url: "/v1/banks/058/accounts/12", headers: w.auth })).statusCode, 400);
});

test("a cash-out end to end: open, fund, and paj.cash's own answer moves it on", async () => {
  const w = world();
  const body = { id: "co_000001", merchant: MERCHANT, destination: "bank:NG:058:0123456789", amount: "25000000" };
  const opened = await w.app.inject({ method: "POST", url: "/v1/cashouts", headers: w.auth, payload: body });
  assert.equal(opened.statusCode, 200);
  assert.equal(opened.json().state, "awaiting-funds");
  assert.equal(opened.json().deposit, "Dep");
  assert.equal(opened.json().fundMinor, "25000000");
  // The same request again: the same order, and paj.cash asked once.
  const again = await w.app.inject({ method: "POST", url: "/v1/cashouts", headers: w.auth, payload: body });
  assert.deepEqual(again.json(), opened.json());
  assert.equal(w.offramps(), 1);

  const funded = await w.app.inject({ method: "POST", url: "/v1/cashouts/co_000001/funded", headers: w.auth, payload: { signature: SIG } });
  assert.equal(funded.json().state, "funded");

  // A webhook claiming it is done is only a prompt; paj.cash still says INIT.
  await w.app.inject({ method: "POST", url: "/v1/paj/webhook/hook-secret", payload: { id: "ord_1", status: "COMPLETED" } });
  assert.equal(w.store.read().cashouts["co_000001"]!.state, "funded");
  w.setStatus("COMPLETED");
  await w.app.inject({ method: "POST", url: "/v1/paj/webhook/hook-secret", payload: { id: "ord_1" } });
  assert.equal(w.store.read().cashouts["co_000001"]!.state, "paid");
  const seen = await w.app.inject({ method: "GET", url: "/v1/cashouts/co_000001", headers: w.auth });
  assert.equal(seen.json().state, "paid");
});

test("two requests for one cash-out at once open one order", async () => {
  const w = world();
  const body = { id: "co_000001", merchant: MERCHANT, destination: "bank:NG:058:0123456789", amount: "25000000" };
  await Promise.all([
    w.app.inject({ method: "POST", url: "/v1/cashouts", headers: w.auth, payload: body }),
    w.app.inject({ method: "POST", url: "/v1/cashouts", headers: w.auth, payload: body }),
  ]);
  assert.equal(w.offramps(), 1);
});

test("a webhook with the wrong secret is ignored", async () => {
  const w = world();
  assert.equal((await w.app.inject({ method: "POST", url: "/v1/paj/webhook/guess", payload: { id: "ord_1" } })).statusCode, 404);
});

test("a lapsed paj.cash session is a 503 that says to log in, not a refusal", async () => {
  const w = world({ sessionExpired: true });
  const r = await w.app.inject({
    method: "POST",
    url: "/v1/cashouts",
    headers: w.auth,
    payload: { id: "co_000001", merchant: MERCHANT, destination: "bank:NG:058:0123456789", amount: "25000000" },
  });
  assert.equal(r.statusCode, 503);
  assert.equal(r.json().login, true);
  assert.equal(w.store.read().cashouts["co_000001"]!.state, "creating", "kept, to go through after login");
});

test("bad input is a 400, and a refused cash-out says why", async () => {
  const w = world();
  assert.equal((await w.app.inject({ method: "POST", url: "/v1/cashouts", headers: w.auth, payload: { id: "x" } })).statusCode, 400);
  const small = await w.app.inject({
    method: "POST",
    url: "/v1/cashouts",
    headers: w.auth,
    payload: { id: "co_000002", merchant: MERCHANT, destination: "bank:NG:058:0123456789", amount: "10" },
  });
  assert.equal(small.statusCode, 422);
});
