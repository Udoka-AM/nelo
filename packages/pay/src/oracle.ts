/**
 * Turning an oracle quote into a price the till can charge.
 *
 * A merchant prices goods off this. A quote that is stale, or whose confidence
 * band is wide enough to drive a bus through, will silently mis-price every
 * sale until someone notices — so a quote is not a number, it is a number plus
 * the two questions "how old?" and "how sure?", and both are refused here
 * rather than displayed.
 *
 * Deliberately provider-agnostic. Pyth publishes an integer price with a
 * base-10 exponent, a confidence interval and a publish time; Switchboard
 * publishes the same shape. Whichever is wired up, this is the part that has to
 * be right, and it is testable without a network.
 */
import type { Rate } from "./index.ts";

export interface OracleQuote {
  /** Integer price as published — e.g. 5812345 with expo -5 means 58.12345. */
  price: bigint;
  /** Base-10 exponent, normally negative. */
  expo: number;
  /** Confidence interval, in the same units and scale as `price`. */
  conf: bigint;
  /** Unix seconds. */
  publishTime: number;
}

export interface QuoteGuards {
  /** Older than this and the quote is refused. */
  maxAgeSeconds: number;
  /** Refuse when the confidence band exceeds this share of the price, in bps. */
  maxConfidenceBps: number;
}

/**
 * A POS is not a trading desk. Thirty seconds is generous for a counter, and
 * fifty basis points is already a wide band for a major FX pair — past that,
 * the oracle is telling you it does not know.
 */
export const DEFAULT_GUARDS: QuoteGuards = {
  maxAgeSeconds: 30,
  maxConfidenceBps: 50,
};

export type QuoteResult =
  | { ok: true; rate: Rate; ageSeconds: number; confidenceBps: number }
  | { ok: false; reason: string };

export function confidenceBps(quote: OracleQuote): number {
  if (quote.price <= 0n) return Number.POSITIVE_INFINITY;
  // Integer maths first, so a huge price does not lose the confidence in a float.
  return Number((quote.conf * 10_000n) / quote.price);
}

/**
 * Convert a quote of "local currency per 1 USD" into a `Rate`.
 *
 * Refuses rather than guesses. Every caller must handle the failure, because
 * the alternative is a till that keeps trading on a price nobody stands behind.
 */
export function quoteToRate(
  quote: OracleQuote,
  nowSeconds: number,
  minorPerMajor: bigint,
  guards: QuoteGuards = DEFAULT_GUARDS,
): QuoteResult {
  if (quote.price <= 0n) {
    return { ok: false, reason: "oracle reported a non-positive price" };
  }
  if (quote.conf < 0n) {
    return { ok: false, reason: "oracle reported a negative confidence interval" };
  }

  const ageSeconds = nowSeconds - quote.publishTime;
  // A quote from the future is a clock problem, and just as untrustworthy.
  if (ageSeconds < -5) {
    return { ok: false, reason: "oracle quote is from the future; check the device clock" };
  }
  if (ageSeconds > guards.maxAgeSeconds) {
    return { ok: false, reason: `price is ${ageSeconds}s old; refusing to trade on it` };
  }

  const bps = confidenceBps(quote);
  if (bps > guards.maxConfidenceBps) {
    return { ok: false, reason: `price confidence is ±${bps}bps; too wide to charge on` };
  }

  // Pyth-style: value = price × 10^expo. A negative exponent is the scale.
  const rate: Rate =
    quote.expo <= 0
      ? { localPerUsd: quote.price, scale: -quote.expo, minorPerMajor }
      : { localPerUsd: quote.price * 10n ** BigInt(quote.expo), scale: 0, minorPerMajor };

  return { ok: true, rate, ageSeconds: Math.max(0, ageSeconds), confidenceBps: bps };
}

// ------------------------------------------------------------- Hermes ---

/** Pyth's Hermes `parsed` entry, trimmed to what matters. */
interface HermesParsed {
  id: string;
  price: { price: string; conf: string; expo: number; publish_time: number };
}

/**
 * Fetch a single feed from a Hermes instance.
 *
 * `apiKey` is not optional in practice: hermes.pyth.network serves feed
 * metadata publicly but returns 401 for prices, so a key or a self-hosted
 * instance is required. See docs/DELIVERABLES.md.
 */
export async function fetchHermesQuote(
  baseUrl: string,
  feedId: string,
  apiKey?: string,
): Promise<OracleQuote> {
  const url = `${baseUrl.replace(/\/$/, "")}/v2/updates/price/latest?ids%5B%5D=${feedId}`;
  const response = await fetch(url, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
  });
  if (response.status === 401) {
    throw new Error("Hermes rejected the request: a price-feed API key is required");
  }
  if (!response.ok) throw new Error(`Hermes returned HTTP ${response.status}`);

  const body = (await response.json()) as { parsed?: HermesParsed[] };
  const entry = body.parsed?.[0];
  if (!entry) throw new Error(`Hermes returned no price for feed ${feedId}`);

  return {
    price: BigInt(entry.price.price),
    conf: BigInt(entry.price.conf),
    expo: entry.price.expo,
    publishTime: entry.price.publish_time,
  };
}
