/**
 * paj.cash speaks in decimal numbers: `"amount": 100`, `"rate": 1525`,
 * `"fiatAmount": 152500.5`. Everything here is integer minor units. This file
 * is the only crossing, and it is exact in both directions or it refuses.
 *
 * A JSON number is parsed by JavaScript into a double, which cannot hold most
 * decimal fractions. But `String(double)` prints the shortest text that reads
 * back as the same double, and for amounts with at most 15 significant digits
 * that text is exactly the decimal that was sent. So numbers are read through
 * their text, never through arithmetic, and anything with more digits than a
 * double can carry is refused rather than rounded.
 */
import type { ConversionRate } from "../money.ts";

/** Significant digits a double always carries exactly. */
const SAFE_DIGITS = 15;

function decimalText(value: number | string): string {
  const text = typeof value === "number" ? String(value) : value.trim();
  if (typeof value === "number" && !Number.isFinite(value)) throw new RangeError(`not a finite number: ${value}`);
  if (/e/i.test(text)) {
    // `String` switches to exponent form below 1e-6 and above 1e21. Neither
    // is an amount of money this service should ever see.
    throw new RangeError(`amount out of range: ${text}`);
  }
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new RangeError(`not a decimal number: ${text}`);
  return text;
}

/**
 * `"12.5"` or `12.5` → 12_500_000n at 6 decimals. Refuses more fraction
 * digits than `decimals`, unless `round` says to drop them, and then always
 * toward zero: rounding someone else's money up is inventing it.
 */
export function toMinor(value: number | string, decimals: number, round: "exact" | "down" = "exact"): bigint {
  const text = decimalText(value);
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = (negative ? text.slice(1) : text).split(".") as [string, string?];
  const digits = (whole.replace(/^0+(?=\d)/, "") + fraction).replace(/^0+/, "");
  if (typeof value === "number" && digits.length > SAFE_DIGITS) {
    throw new RangeError(`${text} has more digits than a JSON number carries exactly`);
  }
  let kept = fraction;
  if (fraction.length > decimals) {
    if (round === "exact" && /[1-9]/.test(fraction.slice(decimals))) {
      throw new RangeError(`${text} has more than ${decimals} decimal places`);
    }
    kept = fraction.slice(0, decimals);
  }
  const minor = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(kept.padEnd(decimals, "0") || "0");
  return negative ? -minor : minor;
}

/** 12_500_000n at 6 decimals → `"12.5"`. */
export function toDecimal(minor: bigint, decimals: number): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const base = 10n ** BigInt(decimals);
  const fraction = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${abs / base}${fraction ? `.${fraction}` : ""}`;
}

/**
 * For a JSON body: the same decimal, as a number that serialises back to
 * exactly that text. Refuses one that would not.
 */
export function toJsonNumber(minor: bigint, decimals: number): number {
  const text = toDecimal(minor, decimals);
  const n = Number(text);
  if (String(n) !== text) throw new RangeError(`${text} cannot be sent as a JSON number exactly`);
  return n;
}

/**
 * paj.cash's rate, local currency per US dollar (e.g. 1525 NGN), as the
 * ledger's rate: local minor units per token minor unit, scaled.
 *
 * 1525 NGN per USD, kobo (2 digits) per micro-USDC (6 digits):
 * 1525 × 10² / 10⁶ = 152_500 / 10⁶.
 */
export function rateToConversion(rate: number | string, localDigits: number, tokenDecimals: number): ConversionRate {
  const text = decimalText(rate);
  if (text.startsWith("-") || Number(text) === 0) throw new RangeError(`not a usable rate: ${text}`);
  const fraction = text.split(".")[1] ?? "";
  const scaled = toMinor(text, fraction.length);
  return { localPerToken: scaled * 10n ** BigInt(localDigits), scale: fraction.length + tokenDecimals };
}
