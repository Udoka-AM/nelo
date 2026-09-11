/**
 * Where the till gets its exchange rate.
 *
 * Two things are true today and both are stated on screen rather than hidden:
 *
 *  1. Pyth publishes no NGN feed. It covers ZAR, INR, PHP and 36 other pairs,
 *     but not the naira — so a Nigerian launch needs a different oracle, or a
 *     different launch currency. See docs/DELIVERABLES.md.
 *  2. hermes.pyth.network serves feed metadata publicly but returns 401 for
 *     prices. A key, or a self-hosted Hermes, is required.
 *
 * Until one of those is resolved the till runs on a configured rate, and the
 * screen says so. A POS that shows a made-up number as though it were live is
 * worse than one that admits it.
 */
import { fetchHermesQuote, quoteToRate, type Rate } from "@nelo/pay";

const HERMES_URL = "https://hermes.pyth.network";
/** Set once a key exists; until then the configured rate is used. */
const HERMES_API_KEY: string | undefined = undefined;

/**
 * Pyth FX feed ids, each verified against hermes.pyth.network/v2/price_feeds.
 *
 * There is **no NGN feed**. Pyth covers 39 FX pairs and the naira is not one of
 * them, so a Nigerian launch needs Switchboard, a different oracle, or a
 * different launch currency. Of the markets the plan names, Manila (PHP) is
 * covered and Lagos is not.
 */
export const FEEDS: Record<string, string> = {
  PHP: "2bda7f268b52bfbc3f2e124c31445247647350db313caadc6771e6299e0a68c9",
  ZAR: "389d889017db82bf42141f23b61b8de938a4e2d156e36312175bebf797f493f1",
  INR: "0ac0f9a2886fc2dd708bc66cc2cea359052ce89d324f45d95fadbc6c4fcf1809",
  IDR: "6693afcd49878bbd622e46bd805e7177932cf6ab0b1c91b135d71151b9207433",
  MXN: "e13b1c1ffb32f34e1be9545583f01ef385fde7f42ee66049d30570dc866b77ca",
  BRL: "d2db4dbf1aea74e0f666b0e8f73b9580d407f5e5cf931940b06dc633d7a95906",
  TRY: "032a2eba1c2635bf973e95fb62b2c0705c1be2603b9572cc8d5edeaf8744e058",
};

export interface Quoted {
  rate: Rate;
  /** True when this came from an oracle; false when it is the configured rate. */
  live: boolean;
  note?: string;
}

/** The rate the till falls back to. Illustrative, and labelled as such. */
export const CONFIGURED: Record<string, Rate> = {
  NGN: { localPerUsd: 165_025_000_000n, scale: 8, minorPerMajor: 100n },
  PHP: { localPerUsd: 5_812_345n, scale: 5, minorPerMajor: 100n },
};

export async function currentRate(currency: string): Promise<Quoted> {
  const feedId = FEEDS[currency];
  const fallback = CONFIGURED[currency];
  if (!fallback) throw new Error(`no rate configured for ${currency}`);

  if (!feedId) {
    return { rate: fallback, live: false, note: `No ${currency} price feed — rate is fixed` };
  }
  if (!HERMES_API_KEY) {
    return { rate: fallback, live: false, note: "No price-feed key — rate is fixed" };
  }

  try {
    const quote = await fetchHermesQuote(HERMES_URL, feedId, HERMES_API_KEY);
    const result = quoteToRate(quote, Math.floor(Date.now() / 1000), fallback.minorPerMajor);
    if (!result.ok) return { rate: fallback, live: false, note: result.reason };
    return { rate: result.rate, live: true };
  } catch (e) {
    return {
      rate: fallback,
      live: false,
      note: e instanceof Error ? e.message : "price feed unreachable",
    };
  }
}
