/**
 * The relayer's HTTP surface, driven with fastify's inject: no socket, same
 * routing, hooks and serialization as a real request.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { p256 } from "@noble/curves/p256";
import { ed25519 } from "@noble/curves/ed25519";
import { encode, encodeBase58, signedMessage } from "@nelo/voucher";
import { buildServer, emptyLedger, feePayerFromSecret, fileLedger, memoryLedger, redeem, serial, type ConflictRpc } from "../src/index.ts";

const NOW = 1_789_000_000;
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const secret = ed25519.utils.randomPrivateKey();
const FEE_PAYER = feePayerFromSecret(Uint8Array.from([...secret, ...ed25519.getPublicKey(secret)]));

function packetBase64(): string {
  const fields = {
    version: 1,
    vault: new Uint8Array(32).fill(0x11),
    seq: 5n,
    amount: 5_000_000n,
    remainingAfter: 0n,
    merchant: new Uint8Array(32).fill(0x22),
    expiresAt: BigInt(NOW + 3600),
    salt: new Uint8Array(8),
  };
  const sk = new Uint8Array(32).fill(7);
  const bytes = encode({
    ...fields,
    signature: p256.sign(signedMessage(fields), sk, { prehash: true, lowS: true }).toCompactRawBytes(),
    devicePubkey: p256.getPublicKey(sk, true),
  });
  return Buffer.from(bytes).toString("base64");
}

function server(o: { token?: string; rpc?: Partial<ConflictRpc> } = {}) {
  const sent: string[] = [];
  const rpc: ConflictRpc = {
    accountData: async () => null,
    latestBlockhash: async () => ({ blockhash: encodeBase58(new Uint8Array(32).fill(3)), lastValidBlockHeight: 1_000 }),
    blockHeight: async () => 900,
    accountExists: async () => true,
    signatureKnown: async () => false,
    send: async (w) => {
      sent.push(w);
      await new Promise((r) => setTimeout(r, 5)); // let a concurrent request try to overtake
      return { ok: true };
    },
    ...o.rpc,
  };
  const app = buildServer({
    now: () => NOW,
    ...(o.token ? { token: o.token } : {}),
    deps: {
      rpc,
      feePayer: FEE_PAYER,
      ledger: memoryLedger(emptyLedger("2026-09-24")),
      config: { mint: USDC, limits: { budgetLamports: 1e9, maxPerVault: 10, allowedMints: [USDC], sponsorNewAccounts: true } },
    },
  });
  return { app, sent };
}

test("health names the fee payer, with no token needed", async () => {
  const { app } = server({ token: "t" });
  const r = await app.inject({ method: "GET", url: "/v1/health" });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { feePayer: FEE_PAYER.address, mint: USDC });
});

test("without the token, redeem is refused before anything is read", async () => {
  const { app, sent } = server({ token: "t" });
  const r = await app.inject({ method: "POST", url: "/v1/redeem", payload: { packet: packetBase64() } });
  assert.equal(r.statusCode, 401);
  assert.equal(sent.length, 0);
});

test("with the token, a voucher is submitted and its signature returned", async () => {
  const { app, sent } = server({ token: "t" });
  const r = await app.inject({
    method: "POST",
    url: "/v1/redeem",
    headers: { authorization: "Bearer t" },
    payload: { packet: packetBase64() },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().status, "sent");
  assert.equal(sent.length, 1);
});

test("a malformed body is a 400 with a reason", async () => {
  const { app } = server();
  const missing = await app.inject({ method: "POST", url: "/v1/redeem", payload: {} });
  assert.equal(missing.statusCode, 400);
  const short = await app.inject({ method: "POST", url: "/v1/redeem", payload: { packet: "AAAA" } });
  assert.equal(short.statusCode, 400);
  assert.match(short.json().error, /202 bytes/);
});

test("an unreachable RPC before sending is a 503, which the till reads as offline", async () => {
  const { app } = server({ rpc: { accountExists: async () => { throw new Error("ECONNREFUSED"); } } });
  const r = await app.inject({ method: "POST", url: "/v1/redeem", payload: { packet: packetBase64() } });
  assert.equal(r.statusCode, 503);
});

test("two identical requests at once become one transaction", async () => {
  // Driven through redeem directly, because inject may not interleave
  // requests the way sockets do. The control half proves the race is real in
  // this harness, so the serial half is proving something.
  const run = async (wrap: <T>(w: () => Promise<T>) => Promise<T>) => {
    const sent: string[] = [];
    const deps = {
      rpc: {
        latestBlockhash: async () => ({ blockhash: encodeBase58(new Uint8Array(32).fill(3)), lastValidBlockHeight: 1_000 }),
        blockHeight: async () => 900,
        accountExists: async () => {
          await new Promise((r) => setTimeout(r, 5));
          return true;
        },
        signatureKnown: async () => false,
        send: async (w: string) => {
          sent.push(w);
          return { ok: true as const };
        },
      },
      feePayer: FEE_PAYER,
      ledger: memoryLedger(emptyLedger("2026-09-24")),
      config: { mint: USDC, limits: { budgetLamports: 1e9, maxPerVault: 10, allowedMints: [USDC], sponsorNewAccounts: true } },
      now: NOW,
    };
    const bytes = new Uint8Array(Buffer.from(packetBase64(), "base64"));
    const [a, b] = await Promise.all([wrap(() => redeem(bytes, deps)), wrap(() => redeem(bytes, deps))]);
    return { a, b, sent: sent.length };
  };

  const racing = await run((w) => w());
  assert.equal(racing.sent, 2, "control: unserialised, the same voucher goes out twice");

  const serialised = await run(serial());
  assert.equal(serialised.sent, 1);
  assert.deepEqual(serialised.a, serialised.b);
});

test("the file ledger survives a restart", () => {
  const path = join(mkdtempSync(join(tmpdir(), "relay-")), "ledger.json");
  const first = fileLedger(path, "2026-09-24");
  const state = { ...emptyLedger("2026-09-24"), spentLamports: 42, fundedMerchants: ["m"] };
  first.write(state);
  assert.deepEqual(fileLedger(path, "2026-09-25").read(), state);
  assert.ok(readFileSync(path, "utf8").includes('"spentLamports": 42'));
});
