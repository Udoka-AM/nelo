/**
 * PajPartner over the real client, against a fake paj.cash v2.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { convert, pajClient, PajPartner, PajError, PAJ_API, PAJ_LIMITS } from "../src/index.ts";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const NOW = Date.parse("2026-10-05T10:00:00Z");

function paj(script: Record<string, (body: any) => { status?: number; body: unknown }>, o: { fee?: bigint } = {}) {
  const asked: { path: string; body: any }[] = [];
  const f = async (url: string, init?: { body?: string }) => {
    const path = url.slice(PAJ_API.length).split("?")[0]!;
    const body = init?.body ? JSON.parse(init.body) : undefined;
    asked.push({ path, body });
    const keys = Object.keys(script).filter((k) => path === k || (k.endsWith("/") && path.startsWith(k)));
    const key = keys.sort((a, b) => b.length - a.length)[0];
    const a = key ? script[key]!(body) : { status: 404, body: { statusCode: 404, message: "Not Found" } };
    return { ok: (a.status ?? 200) < 300, status: a.status ?? 200, text: async () => JSON.stringify(a.body) };
  };
  const partner = new PajPartner({
    client: pajClient({ apiKey: "k", fetch: f }),
    mint: USDC,
    tokenDecimals: 6,
    localCurrency: "NGN",
    localDigits: 2,
    webhookURL: "https://settle.example/v1/paj/webhook/s",
    ...(o.fee ? { businessFeeMinor: o.fee } : {}),
    now: () => NOW,
  });
  return { partner, asked };
}

const BANKS = {
  "/pub/v2/bank": () => ({ body: [{ id: "b-gt", code: "000013", name: "GTBank", country: "NG" }] }),
};
const ORDER = {
  "/pub/v2/offramp": () => ({
    body: { id: "ord_1", address: "Dep", mint: USDC, currency: "NGN", amount: 25, fiatAmount: 40250, rate: 1610, fee: 0, status: "INIT" },
  }),
};
const request = (destination = "bank:NG:000013:0123456789", tokenMinor = 25_000_000n) => ({
  payoutId: "co_000001",
  merchantId: "m",
  destination,
  tokenMinor,
  tokenCurrency: "USDC",
  localMinor: 0n,
  localCurrency: "NGN",
});

test("a quote is paj.cash's off-ramp rate, as the ledger's rate, and live: there is no staging", async () => {
  const { partner, asked } = paj({ "/pub/v2/rate": () => ({ body: { offRampRate: { targetCurrency: "NGN", rate: 1610 } } }) });
  const q = await partner.quote("USDC", "NGN", NOW);
  assert.equal(q.fidelity, "live");
  assert.equal(convert(1_000_000n, q.partnerRate), 161_000n);
  assert.equal(asked[0]!.path, "/pub/v2/rate");
});

test("a bank payout opens an order by paj.cash's bank code, and returns where to send", async () => {
  const { partner, asked } = paj({ ...BANKS, ...ORDER });
  const r = await partner.disburse(request());
  assert.deepEqual(r, {
    status: "accepted",
    partner: "paj",
    fidelity: "live",
    partnerReference: "ord_1",
    funding: { address: "Dep", mint: USDC, tokenMinor: 25_000_000n, localMinor: 4_025_000n },
  });
  const order = asked.find((a) => a.path === "/pub/v2/offramp")!.body;
  assert.deepEqual(order, {
    bankCode: "000013",
    accountNumber: "0123456789",
    currency: "NGN",
    amount: 25,
    mint: USDC,
    chain: "SOLANA",
    webhookURL: "https://settle.example/v1/paj/webhook/s",
    description: "Nelo payout co_000001",
  });
});

test("Nelo's fee rides on the order as businessUSDCFee", async () => {
  const { partner, asked } = paj({ ...BANKS, ...ORDER }, { fee: 250_000n });
  await partner.disburse(request());
  assert.equal(asked.find((a) => a.path === "/pub/v2/offramp")!.body.businessUSDCFee, 0.25);
});

test("paj.cash's limits are checked before any order: $0.50 to $10,000", async () => {
  const { partner, asked } = paj({ ...BANKS, ...ORDER });
  const small = await partner.disburse(request(undefined, PAJ_LIMITS.minTokenMinor - 1n));
  assert.equal(small.status, "rejected");
  if (small.status === "rejected") assert.match(small.reason, /\$0\.50 or more/);
  const big = await partner.disburse(request(undefined, PAJ_LIMITS.maxTokenMinor + 1n));
  assert.equal(big.status, "rejected");
  if (big.status === "rejected") assert.match(big.reason, /\$10,000/);
  assert.ok(!asked.some((a) => a.path === "/pub/v2/offramp"));
  // Exactly the minimum goes through.
  assert.equal((await partner.disburse(request(undefined, PAJ_LIMITS.minTokenMinor))).status, "accepted");
});

test("refused before paj.cash is asked: mobile money, a bank it does not list, a bad destination", async () => {
  const { partner, asked } = paj(BANKS);
  assert.equal((await partner.disburse(request("momo:NG:+2348031234567"))).status, "rejected");
  const gone = await partner.disburse(request("bank:NG:999992:0123456789"));
  assert.equal(gone.status, "rejected");
  if (gone.status === "rejected") assert.match(gone.reason, /no longer lists that bank/);
  assert.equal((await partner.disburse(request("somewhere"))).status, "rejected");
  assert.ok(!asked.some((a) => a.path === "/pub/v2/offramp"));
});

test("a 4xx from paj.cash is a refusal; a refused API key is not, so the same cash-out goes through once it is fixed", async () => {
  const refused = paj({ ...BANKS, "/pub/v2/offramp": () => ({ status: 400, body: { statusCode: 400, message: ["Account could not be resolved"] } }) }).partner;
  const r = await refused.disburse(request());
  assert.equal(r.status, "rejected");
  if (r.status === "rejected") assert.match(r.reason, /could not be resolved/);
  const lapsed = paj({ ...BANKS, "/pub/v2/offramp": () => ({ status: 401, body: { statusCode: 401, message: "Invalid API key" } }) }).partner;
  await assert.rejects(lapsed.disburse(request()), (e: unknown) => e instanceof PajError && e.auth);
  const down = paj({ ...BANKS, "/pub/v2/offramp": () => ({ status: 502, body: {} }) }).partner;
  await assert.rejects(down.disburse(request()), (e: unknown) => e instanceof PajError && e.status === 502);
});

test("an order paying a different mint than configured is refused, not funded", async () => {
  const { partner } = paj({
    ...BANKS,
    "/pub/v2/offramp": () => ({ body: { id: "o", address: "Dep", mint: "Other1111", currency: "NGN", amount: 25, fiatAmount: 40250, rate: 1610 } }),
  });
  assert.equal((await partner.disburse(request())).status, "rejected");
});

test("paj.cash's order states map forward; an unknown one, or a deleted order, changes nothing", async () => {
  let status = "INIT";
  let gone = false;
  const { partner } = paj({
    "/pub/v2/transaction/": () =>
      gone ? { status: 404, body: { statusCode: 404, message: "Not Found" } } : { body: { id: "ord_1", status, transactionType: "OFF_RAMP" } },
  });
  const states: (string | null)[] = [];
  for (const s of ["INIT", "PROCESSING", "COMPLETED", "ERROR", "ON_HOLD"]) {
    status = s;
    states.push((await partner.status("ord_1")).state);
  }
  assert.deepEqual(states, ["awaiting-funds", "processing", "paid", "failed", null]);
  status = "ERROR";
  assert.match((await partner.status("ord_1")).detail, /refund or retry.*ord_1/);
  gone = true;
  assert.deepEqual(await partner.status("ord_1"), { state: null, detail: "paj.cash no longer has this order" });
});

test("the bank list is fetched once an hour, not per payout, and codes match exactly", async () => {
  const { partner, asked } = paj(BANKS);
  assert.equal((await partner.bankFor("000013"))?.name, "GTBank");
  assert.equal(await partner.bankFor("013"), null);
  assert.equal(asked.filter((a) => a.path === "/pub/v2/bank").length, 1);
});

test("resolving an account registers it with paj.cash: the name comes from the bank", async () => {
  const { partner, asked } = paj({
    ...BANKS,
    "/pub/v2/bank-account": (body: any) => ({
      body: { id: "acct_1", accountName: "ADA OKAFOR", accountNumber: body.accountNumber, bank: "GTBank", address: "Standing" },
    }),
  });
  const r = await partner.resolve("000013", "0123456789");
  assert.equal(r?.accountName, "ADA OKAFOR");
  assert.equal(r?.bank.name, "GTBank");
  assert.deepEqual(asked.find((a) => a.path === "/pub/v2/bank-account")!.body, { bankCode: "000013", accountNumber: "0123456789" });
  // A bank paj.cash does not list is not sent at all.
  assert.equal(await partner.resolve("999992", "0123456789"), null);
  assert.equal(asked.filter((a) => a.path === "/pub/v2/bank-account").length, 1);
});
