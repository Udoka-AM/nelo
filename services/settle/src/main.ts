/**
 * Run the settlement service: cash-outs through paj.cash (API v2).
 *
 *   PAJ_API_KEY             Nelo's paj.cash business key. Server-side only.
 *   PAJ_WEBHOOK_SECRET      the key's signing secret (whsec_…), from paj.cash's
 *                           dashboard. Set: every webhook delivery must verify.
 *   SETTLE_PUBLIC_URL       this service's public HTTPS address, for paj.cash's webhook
 *   SETTLE_WEBHOOK_SECRET   a random string, part of the webhook's path
 *   SETTLE_TOKEN            bearer token the merchant app sends
 *   SETTLE_CASHOUTS_FILE    default ~/.config/nelo/cashouts.json
 *   SETTLE_MINT             the USDC mint paj.cash takes (default mainnet USDC)
 *   SETTLE_PORT / SETTLE_HOST  default 8788 on 127.0.0.1
 *   NELO_FEE_USDC           Nelo's fee per cash-out, in USDC, added on top by paj.cash (optional)
 *
 * paj.cash has no staging environment: this moves real money, in mainnet
 * USDC. See docs-site/operations/relay.mdx.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileCashouts } from "./cashout.ts";
import { pajClient, USDC_MAINNET } from "./paj/client.ts";
import { toMinor } from "./paj/decimal.ts";
import { PAJ_LIMITS, PajPartner } from "./paj/partner.ts";
import { buildSettle } from "./server.ts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is not set. See the header of services/settle/src/main.ts.`);
    process.exit(1);
  }
  return value;
}

const home = join(homedir(), ".config", "nelo");
const cashoutsFile = process.env.SETTLE_CASHOUTS_FILE?.trim() || join(home, "cashouts.json");
mkdirSync(dirname(cashoutsFile), { recursive: true });

const publicUrl = required("SETTLE_PUBLIC_URL").replace(/\/+$/, "");
const webhookSecret = required("SETTLE_WEBHOOK_SECRET");
const signingSecret = process.env.PAJ_WEBHOOK_SECRET?.trim();
const fee = process.env.NELO_FEE_USDC?.trim();
const mint = process.env.SETTLE_MINT?.trim() || USDC_MAINNET;

const partner = new PajPartner({
  client: pajClient({ apiKey: required("PAJ_API_KEY") }),
  mint,
  tokenDecimals: 6,
  localCurrency: "NGN",
  localDigits: 2,
  webhookURL: `${publicUrl}/v1/paj/webhook/${webhookSecret}`,
  ...(fee ? { businessFeeMinor: toMinor(fee, 6) } : {}),
});

const app = buildSettle({
  partner,
  store: fileCashouts(cashoutsFile),
  now: Date.now,
  ...(process.env.SETTLE_TOKEN?.trim() ? { token: process.env.SETTLE_TOKEN.trim() } : {}),
  webhookSecret,
  ...(signingSecret ? { pajSigningSecret: signingSecret } : {}),
  tokenCurrency: "USDC",
  localCurrency: "NGN",
  limits: { perMerchantPerDay: 5, minTokenMinor: PAJ_LIMITS.minTokenMinor },
});

const port = Number(process.env.SETTLE_PORT ?? "8788");
const host = process.env.SETTLE_HOST?.trim() || "127.0.0.1";
await app.listen({ port, host });
console.log(`nelo settle on http://${host}:${port} · paj.cash v2, live · mint ${mint}`);
if (mint !== USDC_MAINNET) console.warn(`SETTLE_MINT is not mainnet USDC: paj.cash settles in ${USDC_MAINNET}.`);
if (!signingSecret) console.warn("PAJ_WEBHOOK_SECRET is not set: webhooks are not signature-checked (they still only prompt a lookup).");
if (!process.env.SETTLE_TOKEN) console.warn("SETTLE_TOKEN is not set: anyone who finds the URL can open cash-outs.");
