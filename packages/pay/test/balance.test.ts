/**
 * Reading a balance. Every test here is a response shape that would otherwise
 * either crash the till or show a merchant a number that is not theirs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sumTokenAccounts, type ParsedTokenAccount } from "../src/balance.ts";
import { tokenBaseUnitsToLocalMinor, formatLocalAmount, type Rate } from "../src/index.ts";

const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const OTHER = "So11111111111111111111111111111111111111112";

const account = (mint: string, amount: string): ParsedTokenAccount => ({
  account: { data: { parsed: { info: { mint, owner: "merchant", tokenAmount: { amount } } } } },
});

test("a merchant who has never been paid has a zero balance, not an error", () => {
  // No token account exists until someone pays them. This is every merchant's
  // first screen.
  assert.equal(sumTokenAccounts([], USDC), 0n);
  assert.equal(sumTokenAccounts(undefined, USDC), 0n);
  assert.equal(sumTokenAccounts(null, USDC), 0n);
});

test("balances across several accounts for the same mint are summed", () => {
  const total = sumTokenAccounts(
    [account(USDC, "1000000"), account(USDC, "2500000")],
    USDC,
  );
  assert.equal(total, 3_500_000n);
});

/** The RPC was asked to filter by mint. Checking anyway is cheap. */
test("another mint is ignored even if the RPC returns it", () => {
  const total = sumTokenAccounts([account(USDC, "1000000"), account(OTHER, "9999999")], USDC);
  assert.equal(total, 1_000_000n);
});

test("a malformed entry is skipped rather than taking the screen down", () => {
  const total = sumTokenAccounts(
    [
      account(USDC, "1000000"),
      {} as ParsedTokenAccount,
      { account: { data: { parsed: { info: {} } } } },
      { account: { data: { parsed: { info: { mint: USDC, tokenAmount: {} } } } } },
      { account: { data: { parsed: { info: { mint: USDC, tokenAmount: { amount: "nope" } } } } } },
      account(USDC, "500000"),
    ],
    USDC,
  );
  assert.equal(total, 1_500_000n, "the readable entries still count");
});

test("a balance larger than a JS number survives", () => {
  // 2^53 base units is about 9 billion USDC — absurd, and exactly the kind of
  // thing that silently loses precision if it ever touches a float.
  const huge = "9007199254740993";
  assert.equal(sumTokenAccounts([account(USDC, huge)], USDC), BigInt(huge));
});

// ------------------------------------------------- held in dollars, shown ---

/** ₦1,650.25 per dollar. */
const NGN: Rate = { localPerUsd: 165_025_000_000n, scale: 8, minorPerMajor: 100n };

test("the displayed balance rounds down, never up", () => {
  // $10.000001 — the fraction must not round the naira figure up.
  const held = sumTokenAccounts([account(USDC, "10000001")], USDC);
  const shown = tokenBaseUnitsToLocalMinor(held, NGN);
  const exact = (10_000_001n * 100n * 165_025_000_000n) / 10n ** 14n;
  assert.equal(shown, exact);

  // The property that matters: converting back never claims more than is held.
  const backToToken = (shown * 10n ** 14n) / (100n * 165_025_000_000n);
  assert.ok(backToToken <= held, "a shown balance must not exceed what is held");
});

test("a balance the merchant can read", () => {
  const held = sumTokenAccounts([account(USDC, "100000000")], USDC); // $100.00
  assert.equal(formatLocalAmount(tokenBaseUnitsToLocalMinor(held, NGN), 2), "165025.00");
});

test("a zero balance formats as zero, not as empty", () => {
  assert.equal(formatLocalAmount(tokenBaseUnitsToLocalMinor(0n, NGN), 2), "0.00");
});
