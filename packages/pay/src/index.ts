/**
 * Solana Pay transfer requests, and the local-currency arithmetic around them.
 *
 * Everything here is pure. The merchant terminal's two riskiest pieces are the
 * payment URL (wrong and the customer's wallet either refuses it or pays the
 * wrong amount) and the currency conversion (wrong and the merchant is
 * silently underpaid). Neither should first be exercised on a phone.
 *
 * Implements the Solana Pay spec's transfer request:
 *   solana:<recipient>?amount=<n>&spl-token=<mint>&reference=<pk>&label=&message=
 */

export interface TransferRequest {
  /** Merchant wallet, base58. */
  recipient: string;
  /** Decimal string in whole tokens, e.g. "12.50" — not base units. */
  amount: string;
  /** SPL mint, base58. Omit for native SOL. */
  splToken?: string;
  /** Reference keys the merchant polls on to detect payment. */
  reference?: string[];
  label?: string;
  message?: string;
  memo?: string;
}

/**
 * Build the `solana:` URL a customer's wallet scans.
 *
 * The customer needs nothing special here — any wallet that speaks Solana Pay
 * works, which is the whole reason the online path has no app requirement.
 */
export function encodeTransferRequest(request: TransferRequest): string {
  if (!request.recipient) throw new Error("recipient is required");
  if (!/^\d+(\.\d+)?$/.test(request.amount)) {
    throw new Error(`amount must be a non-negative decimal string, got "${request.amount}"`);
  }

  const params = new URLSearchParams();
  params.append("amount", request.amount);
  if (request.splToken) params.append("spl-token", request.splToken);
  for (const reference of request.reference ?? []) params.append("reference", reference);
  if (request.label) params.append("label", request.label);
  if (request.message) params.append("message", request.message);
  if (request.memo) params.append("memo", request.memo);

  // URLSearchParams encodes spaces as '+', which wallets read literally.
  return `solana:${request.recipient}?${params.toString().replace(/\+/g, "%20")}`;
}

export function decodeTransferRequest(url: string): TransferRequest {
  if (!url.startsWith("solana:")) throw new Error("not a solana: URL");
  const withoutScheme = url.slice("solana:".length);
  const [recipient, query = ""] = withoutScheme.split("?");
  if (!recipient) throw new Error("missing recipient");
  const params = new URLSearchParams(query);
  const amount = params.get("amount");
  if (amount === null) throw new Error("missing amount");
  const out: TransferRequest = { recipient, amount };
  const splToken = params.get("spl-token");
  if (splToken) out.splToken = splToken;
  const reference = params.getAll("reference");
  if (reference.length) out.reference = reference;
  for (const key of ["label", "message", "memo"] as const) {
    const value = params.get(key);
    if (value) out[key] = value;
  }
  return out;
}

// ------------------------------------------------------ local currency ---

/**
 * A price quote. Held as scaled integers because floating point has no place
 * anywhere near money: 0.1 + 0.2 !== 0.3, and a POS that drifts by a hundredth
 * of a cent per sale is a reconciliation problem by the end of the week.
 */
export interface Rate {
  /** Units of local currency per 1 USD, scaled by 10^scale. */
  localPerUsd: bigint;
  scale: number;
  /** Minor units per major unit: 100 for naira/kobo, 1 for a zero-decimal currency. */
  minorPerMajor: bigint;
}

export const USDC_DECIMALS = 6;

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/**
 * Convert a price the merchant typed into the token base units the customer
 * must send.
 *
 * Rounds **up**. The remainder is a fraction of a cent, and it should land in
 * the merchant's favour rather than leaving them a hair short on every sale.
 */
export function localToTokenBaseUnits(
  localMinor: bigint,
  rate: Rate,
  tokenDecimals: number = USDC_DECIMALS,
): bigint {
  if (localMinor < 0n) throw new Error("amount cannot be negative");
  if (rate.localPerUsd <= 0n) throw new Error("rate must be positive");

  const numerator = localMinor * pow10(rate.scale) * pow10(tokenDecimals);
  const denominator = rate.minorPerMajor * rate.localPerUsd;
  // Ceiling division on integers.
  return (numerator + denominator - 1n) / denominator;
}

/**
 * The inverse, for showing a merchant what arrived. Rounds **down**, so a
 * displayed balance is never larger than what is actually there.
 */
export function tokenBaseUnitsToLocalMinor(
  baseUnits: bigint,
  rate: Rate,
  tokenDecimals: number = USDC_DECIMALS,
): bigint {
  if (baseUnits < 0n) throw new Error("amount cannot be negative");
  const numerator = baseUnits * rate.minorPerMajor * rate.localPerUsd;
  return numerator / (pow10(rate.scale) * pow10(tokenDecimals));
}

/** Base units → the decimal string Solana Pay wants (whole tokens). */
export function formatTokenAmount(baseUnits: bigint, decimals: number = USDC_DECIMALS): string {
  const divisor = pow10(decimals);
  const whole = baseUnits / divisor;
  const fraction = (baseUnits % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/** Minor units → a display string, e.g. 1500000n with 2dp → "15000.00". */
export function formatLocalAmount(minor: bigint, minorDigits: number = 2): string {
  if (minorDigits === 0) return minor.toString();
  const divisor = pow10(minorDigits);
  const whole = minor / divisor;
  const fraction = (minor % divisor).toString().padStart(minorDigits, "0");
  return `${whole}.${fraction}`;
}

export {
  base64AddressToBase58,
  decodeBase58,
  decodeBase64,
  encodeBase58,
} from "./base58.ts";
export {
  referenceFromBytes,
  validatePayment,
  type ExpectedPayment,
  type ParsedTransaction,
  type TokenBalance,
  type Validation,
} from "./detect.ts";
