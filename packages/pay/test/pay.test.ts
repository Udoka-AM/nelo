import { test } from "node:test";
import assert from "node:assert/strict";
import {
  base64AddressToBase58,
  decodeBase58,
  decodeBase64,
  decodeTransferRequest,
  encodeBase58,
  encodeTransferRequest,
  formatLocalAmount,
  formatTokenAmount,
  localToTokenBaseUnits,
  tokenBaseUnitsToLocalMinor,
  type Rate,
} from "../src/index.ts";

const MERCHANT = "9EDhKVwHe5csswhp5PcY1DDwJRkfsrZKao7vsQPe7yrh";
const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

// ------------------------------------------------------------- base58 ---

test("base58 round-trips", () => {
  for (const bytes of [
    new Uint8Array(0),
    Uint8Array.from([0]),
    Uint8Array.from([0, 0, 1]),
    Uint8Array.from([255, 255, 255]),
    new Uint8Array(32).fill(7),
  ]) {
    assert.deepEqual(decodeBase58(encodeBase58(bytes)), bytes);
  }
});

test("base58 decodes a known Solana address to 32 bytes", () => {
  assert.equal(decodeBase58(MERCHANT).length, 32);
  assert.equal(encodeBase58(decodeBase58(MERCHANT)), MERCHANT);
});

test("base58 preserves leading zeros", () => {
  // A leading zero byte is '1'; dropping it silently changes the address.
  const withLeadingZero = Uint8Array.from([0, 0, 42]);
  assert.ok(encodeBase58(withLeadingZero).startsWith("11"));
  assert.deepEqual(decodeBase58(encodeBase58(withLeadingZero)), withLeadingZero);
});

test("base58 rejects characters outside the alphabet", () => {
  assert.throws(() => decodeBase58("0OIl"), /invalid base58/);
});

// ----------------------------------------------------- transfer request ---

test("builds a Solana Pay transfer request", () => {
  const url = encodeTransferRequest({
    recipient: MERCHANT,
    amount: "12.50",
    splToken: USDC_DEVNET,
    reference: ["11111111111111111111111111111111"],
    label: "Mama Ngozi Stores",
    message: "Order 42",
  });
  assert.ok(url.startsWith(`solana:${MERCHANT}?`));
  assert.ok(url.includes("amount=12.50"));
  assert.ok(url.includes(`spl-token=${USDC_DEVNET}`));
  assert.ok(url.includes("reference=11111111111111111111111111111111"));
});

test("spaces are percent-encoded, not '+'", () => {
  // Wallets read '+' literally, so a merchant would show as "Mama+Ngozi".
  const url = encodeTransferRequest({
    recipient: MERCHANT,
    amount: "1",
    label: "Mama Ngozi Stores",
  });
  assert.ok(url.includes("%20"), "expected percent-encoded spaces");
  assert.ok(!url.includes("+"), "must not contain a literal '+'");
  assert.equal(decodeTransferRequest(url).label, "Mama Ngozi Stores");
});

test("transfer request round-trips", () => {
  const request = {
    recipient: MERCHANT,
    amount: "0.000001",
    splToken: USDC_DEVNET,
    reference: ["11111111111111111111111111111111"],
    label: "Stall 7",
    message: "Thanks",
  };
  assert.deepEqual(decodeTransferRequest(encodeTransferRequest(request)), request);
});

test("rejects a malformed amount", () => {
  for (const amount of ["", "abc", "-1", "1.2.3", "1,50"]) {
    assert.throws(
      () => encodeTransferRequest({ recipient: MERCHANT, amount }),
      /amount must be/,
      `should reject "${amount}"`,
    );
  }
});

// --------------------------------------------------- currency arithmetic ---

/** ₦1,650.25 to the dollar, scaled by 1e8. */
const NGN: Rate = { localPerUsd: 165_025_000_000n, scale: 8, minorPerMajor: 100n };

test("converts local currency to USDC base units", () => {
  // ₦16,502.50 at 1650.25/USD is exactly $10.
  assert.equal(localToTokenBaseUnits(1_650_250n, NGN), 10_000_000n);
});

test("conversion rounds up, never leaving the merchant short", () => {
  // ₦1.00 does not divide evenly; the remainder must go the merchant's way.
  const exact = (100n * 10n ** 8n * 10n ** 6n) / (100n * 165_025_000_000n);
  const got = localToTokenBaseUnits(100n, NGN);
  assert.ok(got >= exact, "must not round down");
  assert.equal(got, exact + 1n, "rounds up by exactly one base unit");
});

test("display conversion rounds down, never overstating a balance", () => {
  const local = tokenBaseUnitsToLocalMinor(10_000_000n, NGN);
  assert.equal(local, 1_650_250n);
  // A dust amount must not display as more than it is.
  assert.equal(tokenBaseUnitsToLocalMinor(1n, NGN), 0n);
});

test("a zero-decimal currency works", () => {
  const JPY: Rate = { localPerUsd: 15_000_000_000n, scale: 8, minorPerMajor: 1n };
  assert.equal(localToTokenBaseUnits(150n, JPY), 1_000_000n); // ¥150 = $1
});

test("conversion rejects nonsense", () => {
  assert.throws(() => localToTokenBaseUnits(-1n, NGN), /negative/);
  assert.throws(() => localToTokenBaseUnits(1n, { ...NGN, localPerUsd: 0n }), /positive/);
});

test("formats token amounts for the URL", () => {
  assert.equal(formatTokenAmount(12_500_000n), "12.5");
  assert.equal(formatTokenAmount(1n), "0.000001");
  assert.equal(formatTokenAmount(10_000_000n), "10");
  assert.equal(formatTokenAmount(0n), "0");
});

test("formatted token amounts are accepted by the URL builder", () => {
  // The two must agree, or a valid sale produces an unscannable code.
  for (const units of [0n, 1n, 999_999n, 12_500_000n, 1_000_000_000n]) {
    const amount = formatTokenAmount(units);
    assert.doesNotThrow(() => encodeTransferRequest({ recipient: MERCHANT, amount }));
  }
});

test("formats local amounts for display", () => {
  assert.equal(formatLocalAmount(1_650_250n), "16502.50");
  assert.equal(formatLocalAmount(5n), "0.05");
  assert.equal(formatLocalAmount(150n, 0), "150");
});

// ------------------------------------------------- MWA address encoding ---

test("decodes base64, padded and unpadded", () => {
  const cases: [string, number[]][] = [
    ["", []],
    ["AA==", [0]],
    ["AAA=", [0, 0]],
    ["AAAA", [0, 0, 0]],
    ["/w==", [255]],
    ["SGVsbG8=", [72, 101, 108, 108, 111]],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual([...decodeBase64(input)], expected, `for "${input}"`);
  }
});

test("converts an MWA base64 address to base58", () => {
  // Cross-checked against Node's own base64 decoder, not against itself.
  const raw = decodeBase58(MERCHANT);
  const asBase64 = Buffer.from(raw).toString("base64");
  assert.deepEqual([...decodeBase64(asBase64)], [...raw], "base64 decode agrees with Node");
  assert.equal(base64AddressToBase58(asBase64), MERCHANT);
});

test("address conversion survives leading zero bytes", () => {
  // The System Program is 32 zero bytes — the case a naive decoder truncates.
  const zeros = new Uint8Array(32);
  const b64 = Buffer.from(zeros).toString("base64");
  assert.equal(base64AddressToBase58(b64), "11111111111111111111111111111111");
});

test("address conversion rejects anything that is not 32 bytes", () => {
  assert.throws(() => base64AddressToBase58("SGVsbG8="), /32-byte address/);
  assert.throws(() => base64AddressToBase58("!!!!"), /invalid base64/);
});

test("a converted address is usable as a Solana Pay recipient", () => {
  const b64 = Buffer.from(decodeBase58(MERCHANT)).toString("base64");
  const url = encodeTransferRequest({
    recipient: base64AddressToBase58(b64),
    amount: "1.00",
  });
  assert.equal(decodeTransferRequest(url).recipient, MERCHANT);
});
