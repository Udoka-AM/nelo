/**
 * The payer's side of the offline sale: reading the merchant's code, keeping
 * the issuer's state across restarts, and seeing the vault the way a till
 * does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encodeTransferRequest } from "@nelo/pay";
import { decodeRiskConfig, decodeVault } from "@nelo/enrol";
import { limitFor } from "@nelo/accept";
import { encodeBase58 } from "@nelo/voucher";
import {
  chainViewOf,
  fromRecord,
  initialState,
  prepare,
  readMerchantCode,
  toRecord,
} from "../src/index.ts";

const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const MERCHANT = "9EDhKVwHe5csswhp5PcY1DDwJRkfsrZKao7vsQPe7yrh";

// ---- the merchant's code ----

test("the till's own Solana Pay code reads back as merchant and amount", () => {
  // Built with the same encoder the merchant app uses, so this is the real format.
  const url = encodeTransferRequest({
    recipient: MERCHANT,
    amount: "12.5",
    splToken: USDC,
    reference: [MERCHANT],
    label: "Nelo",
    message: "₦20,000.00",
  });
  const r = readMerchantCode(url, USDC);
  assert.deepEqual(r, { ok: true, merchant: MERCHANT, amount: 12_500_000n, label: "Nelo", message: "₦20,000.00" });
});

test("whole amounts and full precision both convert exactly", () => {
  const at = (amount: string) => readMerchantCode(`solana:${MERCHANT}?amount=${amount}&spl-token=${USDC}`, USDC);
  assert.deepEqual(at("3"), { ok: true, merchant: MERCHANT, amount: 3_000_000n });
  assert.deepEqual(at("0.000001"), { ok: true, merchant: MERCHANT, amount: 1n });
});

test("refused: not a code, SOL, another token, no amount, too precise, zero, a bad address", () => {
  const reason = (text: string) => (readMerchantCode(text, USDC) as { reason: string }).reason;
  assert.match(reason("https://example.com"), /not a merchant's payment code/);
  assert.match(reason(`solana:${MERCHANT}?amount=1`), /SOL/);
  assert.match(reason(`solana:${MERCHANT}?amount=1&spl-token=${MERCHANT}`), /different token/);
  assert.match(reason(`solana:${MERCHANT}?spl-token=${USDC}`), /no amount/);
  assert.match(reason(`solana:${MERCHANT}?amount=1.0000001&spl-token=${USDC}`), /more decimals/);
  assert.match(reason(`solana:${MERCHANT}?amount=0&spl-token=${USDC}`), /more than zero/);
  assert.match(reason(`solana:notanaddress?amount=1&spl-token=${USDC}`), /address is not valid/);
  assert.match(reason(`solana:${MERCHANT}?amount=1&amount=100&spl-token=${USDC}`), /ambiguous/);
});

// ---- storage ----

test("issuer state survives storage exactly, pending voucher included", () => {
  const vault = encodeBase58(new Uint8Array(32).fill(0x11));
  const device = new Uint8Array(33).fill(2);
  let s = initialState(vault, device, {
    balance: 2n ** 64n - 1n,
    seqBase: 5n,
    seqBitmap: 2n ** 100n + 3n, // high enough to need 128 bits, low enough to leave the window open
    unlockAt: 0n,
    status: 0,
    limit: 50_000_000n,
    syncedAt: 1_789_000_000,
  });
  const p = prepare(s, { merchant: MERCHANT, amount: 1n, now: 1_789_000_000 }, new Uint8Array(8).fill(9));
  assert.ok(p.ok);
  if (p.ok) s = { ...p.state, outstanding: [{ seq: 1n, amount: 2n, merchant: MERCHANT, expiresAt: 3n }] };
  assert.deepEqual(fromRecord(JSON.parse(JSON.stringify(toRecord(s)))), s);
});

// ---- the vault as the till sees it ----

test("the payer's limit is computed exactly as the till computes it", () => {
  const V = JSON.parse(readFileSync(new URL("../../enrol/vectors/accounts-v1.json", import.meta.url), "utf8"));
  const account = decodeVault(new Uint8Array(Buffer.from(V.vaults[0].dataHex, "hex")));
  const r = decodeRiskConfig(new Uint8Array(Buffer.from(V.riskConfig.dataHex, "hex")));
  const risk = { kBps: r.kBps, stakeReference: r.stakeReference, hardCap: r.hardCap, stakePrice: r.stakePrice, haircutBps: r.haircutBps };
  const view = chainViewOf("vault", account, risk, 100);
  assert.equal(view.balance, account.balance);
  assert.equal(view.seqBitmap, account.seqBitmap);
  assert.ok(view.limit > account.floorLimit, "the stake in this vector lifts the limit");
  assert.equal(
    view.limit,
    limitFor(
      { vault: "vault", devicePubkey: account.devicePubkey, mint: account.mint, balance: account.balance,
        floorLimit: account.floorLimit, stake: account.stake, pendingUnstake: account.pendingUnstake,
        reputationBps: account.reputationBps, seqBase: account.seqBase, seqBitmap: account.seqBitmap,
        status: account.status, syncedAt: 100 },
      risk,
    ),
  );
});
