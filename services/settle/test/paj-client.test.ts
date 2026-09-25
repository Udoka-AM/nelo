/**
 * The paj.cash client against a fake that answers from a script and records
 * the method, path, headers and body of every request. The expected wire
 * shapes are the ones paj.cash's own API reference documents.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pajClient, PajError, PAJ_STAGING } from "../src/paj/client.ts";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SESSION = { token: "tok-123", expiresAt: Date.parse("2026-10-01T00:00:00Z") };

function fake(answer: (path: string, body: any) => { status?: number; body: unknown }) {
  const asked: { method: string; url: string; headers: Record<string, string>; body: any }[] = [];
  const f = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    asked.push({ method: init?.method ?? "GET", url, headers: init?.headers ?? {}, body });
    const a = answer(url.slice(PAJ_STAGING.length), body);
    const status = a.status ?? 200;
    return { ok: status < 300, status, text: async () => JSON.stringify(a.body) };
  };
  return { client: pajClient({ baseUrl: PAJ_STAGING, apiKey: "key-abc", fetch: f }), asked };
}

test("a session: the code goes to a phone or an email, with the API key; the token comes back", async () => {
  const { client, asked } = fake((path) =>
    path === "/pub/verify"
      ? { body: { recipient: "+2348031234567", isActive: "true", expiresAt: "2026-10-01T00:00:00.000Z", token: "tok-123" } }
      : { body: { phone: "+2348031234567" } },
  );
  await client.initiate("+2348031234567");
  await client.initiate("ops@nelo.app");
  const s = await client.verify("+2348031234567", "123456", { uuid: "relay-mac", device: "Server" });
  assert.deepEqual(s, SESSION);
  assert.deepEqual(asked[0], {
    method: "POST",
    url: `${PAJ_STAGING}/pub/initiate`,
    headers: { "content-type": "application/json", "x-api-key": "key-abc" },
    body: { phone: "+2348031234567" },
  });
  assert.deepEqual(asked[1]!.body, { email: "ops@nelo.app" });
  assert.deepEqual(asked[2]!.body, { phone: "+2348031234567", otp: "123456", device: { uuid: "relay-mac", device: "Server" } });
});

test("the off-ramp rate is public and read as it was sent", async () => {
  const { client, asked } = fake(() => ({
    body: {
      onRampRate: { baseCurrency: "USD", targetCurrency: "NGN", isActive: true, rate: 1510, type: "onRamp" },
      offRampRate: { baseCurrency: "USD", targetCurrency: "NGN", isActive: true, rate: 1525, type: "offRamp" },
    },
  }));
  assert.deepEqual(await client.offrampRate(), { rate: 1525, currency: "NGN", active: true });
  assert.equal(asked[0]!.url, `${PAJ_STAGING}/pub/rate`);
  assert.equal(asked[0]!.headers.authorization, undefined, "no credentials on a public call");
  assert.equal(asked[0]!.headers["x-api-key"], undefined);
});

test("banks and the name enquiry carry the session token", async () => {
  const { client, asked } = fake((path) =>
    path === "/pub/bank"
      ? { body: [{ id: "b1", code: "058", name: "GTBank", logo: "x", country: "NG" }] }
      : { body: { accountName: "ADAEZE OKAFOR", accountNumber: "0123456789", bank: { id: "b1" } } },
  );
  assert.deepEqual(await client.banks(SESSION), [{ id: "b1", code: "058", name: "GTBank", country: "NG" }]);
  assert.deepEqual(await client.resolveAccount(SESSION, "b1", "0123456789"), { accountName: "ADAEZE OKAFOR" });
  assert.equal(asked[0]!.headers.authorization, "Bearer tok-123");
  assert.equal(asked[1]!.url, `${PAJ_STAGING}/pub/bank-account/confirm?bankId=b1&accountNumber=0123456789`);
});

test("an off-ramp order is sent in paj.cash's decimals and read back in minor units", async () => {
  const { client, asked } = fake(() => ({
    body: { id: "ord_1", address: "Dep0sit", mint: USDC, currency: "NGN", amount: 25.5, fiatAmount: 38887.5, rate: 1525, fee: 0.05 },
  }));
  const order = await client.createOfframp(SESSION, {
    bankId: "b1",
    accountNumber: "0123456789",
    currency: "NGN",
    tokenMinor: 25_500_000n,
    tokenDecimals: 6,
    mint: USDC,
    webhookURL: "https://settle.example/v1/paj/webhook/s3cret",
    businessFeeMinor: 50_000n,
  });
  assert.deepEqual(asked[0]!.body, {
    bank: "b1",
    accountNumber: "0123456789",
    currency: "NGN",
    amount: 25.5,
    mint: USDC,
    chain: "SOLANA",
    webhookURL: "https://settle.example/v1/paj/webhook/s3cret",
    // The SDK calls this `fee`; the wire field is `businessUSDCFee`.
    businessUSDCFee: 0.05,
  });
  assert.deepEqual(order, {
    id: "ord_1",
    address: "Dep0sit",
    mint: USDC,
    currency: "NGN",
    tokenMinor: 25_500_000n,
    fiatMinor: 3_888_750n,
    rate: 1525,
    feeMinor: 50_000n,
  });
});

test("a transaction's status is read, including states the reference does not list", async () => {
  const { client } = fake(() => ({
    body: { id: "ord_1", status: "FAILED", transactionType: "OFF_RAMP", signature: "5ig", amount: 25.5, fiatAmount: 38887.5 },
  }));
  const t = await client.transaction(SESSION, "ord_1", 6);
  assert.deepEqual(t, { id: "ord_1", status: "FAILED", type: "OFF_RAMP", signature: "5ig", tokenMinor: 25_500_000n, fiatMinor: 3_888_750n });
});

test("errors carry paj.cash's message, and say when the session is the problem", async () => {
  const expired = fake(() => ({ status: 401, body: { message: "Session expired" } })).client;
  await assert.rejects(expired.banks(SESSION), (e: unknown) => {
    assert.ok(e instanceof PajError);
    assert.equal(e.session, true);
    assert.match(e.message, /Session expired/);
    assert.doesNotMatch(e.message, /tok-123|key-abc/, "never a credential in an error");
    return true;
  });
  const bad = fake(() => ({ status: 400, body: { message: "IdNumber already used" } })).client;
  await assert.rejects(bad.createOfframp(SESSION, { bankId: "b", accountNumber: "1", currency: "NGN", tokenMinor: 1n, tokenDecimals: 6, mint: USDC, webhookURL: "x" }), (e: unknown) => e instanceof PajError && !e.session);
  const noOrder = fake(() => ({ body: { id: "", address: "" } })).client;
  await assert.rejects(noOrder.createOfframp(SESSION, { bankId: "b", accountNumber: "1", currency: "NGN", tokenMinor: 1n, tokenDecimals: 6, mint: USDC, webhookURL: "x" }));
});
