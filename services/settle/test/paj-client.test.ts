/**
 * The paj.cash v2 client against a fake that records what went on the wire.
 * Every shape here is from https://docs.paj.cash (API v2, 5 Oct 2026).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PAJ_API, PajError, pajClient } from "../src/paj/client.ts";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function wire(answer: (path: string, body: any) => { status?: number; body: unknown }) {
  const asked: { url: string; method: string; headers: Record<string, string>; body: any }[] = [];
  const f = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    asked.push({ url, method: init?.method ?? "GET", headers: init?.headers ?? {}, body });
    const a = answer(url.slice(PAJ_API.length), body);
    return { ok: (a.status ?? 200) < 300, status: a.status ?? 200, text: async () => JSON.stringify(a.body) };
  };
  return { client: pajClient({ apiKey: "k_live", fetch: f }), asked };
}

test("every request carries the API key, and only on the v2 paths of the production API", async () => {
  const { client, asked } = wire(() => ({ body: { offRampRate: { rate: 1610, targetCurrency: "NGN" } } }));
  await client.offrampRate("NGN");
  assert.equal(asked[0]!.url, `${PAJ_API}/pub/v2/rate?currency=NGN`);
  assert.equal(asked[0]!.headers["x-api-key"], "k_live");
  assert.equal(PAJ_API, "https://api.paj.cash");
});

test("the off-ramp rate is read from offRampRate, never derived from the on-ramp one", async () => {
  const { client } = wire(() => ({
    body: { onRampRate: { rate: 1650, targetCurrency: "NGN" }, offRampRate: { rate: 1610, targetCurrency: "NGN" } },
  }));
  assert.deepEqual(await client.offrampRate("NGN"), { rate: 1610, currency: "NGN" });
});

test("a currency with no live rate is a 404 from paj.cash, surfaced as such", async () => {
  const { client } = wire(() => ({ status: 404, body: { statusCode: 404, message: "Rate not found", error: "Not Found" } }));
  await assert.rejects(client.offrampRate("GHS"), (e: unknown) => e instanceof PajError && e.status === 404 && !e.auth);
});

test("registration sends exactly bankCode and accountNumber, and returns the bank's name for the account", async () => {
  const { client, asked } = wire(() => ({
    body: { id: "68ff", accountName: "John Doe", accountNumber: "0025635480", bank: "First Bank", address: "FsXp" },
  }));
  const r = await client.registerAccount("000016", "0025635480");
  assert.equal(asked[0]!.method, "POST");
  assert.equal(asked[0]!.url, `${PAJ_API}/pub/v2/bank-account`);
  assert.deepEqual(asked[0]!.body, { bankCode: "000016", accountNumber: "0025635480" });
  assert.equal(r.accountName, "John Doe");
  assert.equal(r.address, "FsXp");
});

test("an offramp order sends only documented fields, on Solana, in whole tokens", async () => {
  const { client, asked } = wire(() => ({
    body: { id: "ord_1", address: "Dep", mint: USDC, currency: "NGN", amount: 25.5, fiatAmount: 41055, rate: 1610, fee: 0, status: "INIT" },
  }));
  const o = await client.createOfframp({
    bankCode: "000016",
    accountNumber: "0025635480",
    currency: "NGN",
    tokenMinor: 25_500_000n,
    tokenDecimals: 6,
    mint: USDC,
    webhookURL: "https://x.ngrok-free.app/settle/v1/paj/webhook/s",
    description: "Nelo payout co_1",
  });
  assert.equal(asked[0]!.url, `${PAJ_API}/pub/v2/offramp`);
  assert.deepEqual(asked[0]!.body, {
    bankCode: "000016",
    accountNumber: "0025635480",
    currency: "NGN",
    amount: 25.5,
    mint: USDC,
    chain: "SOLANA",
    webhookURL: "https://x.ngrok-free.app/settle/v1/paj/webhook/s",
    description: "Nelo payout co_1",
  });
  // No fiatAmount alongside amount (paj.cash refuses both), no undocumented field.
  assert.equal("fiatAmount" in asked[0]!.body, false);
  assert.equal(o.tokenMinor, 25_500_000n);
  assert.equal(o.fiatMinor, 4_105_500n);
  assert.equal(o.status, "INIT");
});

test("Nelo's fee goes as businessUSDCFee, and only when there is one", async () => {
  const { client, asked } = wire(() => ({ body: { id: "o", address: "D", mint: USDC, currency: "NGN", amount: 10, fiatAmount: 16100, rate: 1610, fee: 0.5 } }));
  await client.createOfframp({ bankCode: "000016", accountNumber: "0025635480", currency: "NGN", tokenMinor: 10_000_000n, tokenDecimals: 6, mint: USDC, businessFeeMinor: 500_000n });
  assert.equal(asked[0]!.body.businessUSDCFee, 0.5);
  assert.equal("webhookURL" in asked[0]!.body, false);
});

test("a transaction is looked up by id; amounts never round up", async () => {
  const { client, asked } = wire(() => ({
    body: { id: "ord_1", status: "PROCESSING", transactionType: "OFF_RAMP", signature: "5sig", amount: 25.5, fiatAmount: 41055.555 },
  }));
  const t = await client.transaction("ord_1", 6);
  assert.equal(asked[0]!.url, `${PAJ_API}/pub/v2/transaction/ord_1`);
  assert.equal(t.status, "PROCESSING");
  assert.equal(t.fiatMinor, 4_105_555n);
  assert.equal(t.signature, "5sig");
});

test("errors carry paj.cash's message, joined when validation returns an array; 401 is a key problem", async () => {
  const { client } = wire(() => ({
    status: 400,
    body: { statusCode: 400, message: ["bankCode must be a string", "property foo should not exist"], error: "Bad Request" },
  }));
  await assert.rejects(client.registerAccount("x", "y"), (e: unknown) => e instanceof PajError && /bankCode must be a string, property foo/.test(e.message) && !e.auth);
  const refused = wire(() => ({ status: 401, body: { statusCode: 401, message: "Invalid API key", error: "Unauthorized" } })).client;
  await assert.rejects(refused.banks(), (e: unknown) => e instanceof PajError && e.auth && e.message === "Invalid API key");
});

test("banks are fetched for one country and keep paj.cash's code as given", async () => {
  const { client, asked } = wire(() => ({ body: [{ id: "b1", code: "000016", name: "First Bank", country: "NG", logo: null }] }));
  const list = await client.banks("NG");
  assert.equal(asked[0]!.url, `${PAJ_API}/pub/v2/bank?country=NG`);
  assert.deepEqual(list, [{ id: "b1", code: "000016", name: "First Bank", country: "NG" }]);
});
