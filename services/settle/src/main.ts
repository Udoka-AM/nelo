/**
 * Run the settlement service: cash-outs through paj.cash.
 *
 *   PAJ_ENV                 staging (default) or production
 *   PAJ_API_KEY             Nelo's paj.cash business key. Server-side only.
 *   PAJ_SESSION_FILE        default ~/.config/nelo/paj-session.json (see `pnpm paj:login`)
 *   SETTLE_PUBLIC_URL       this service's public HTTPS address, for paj.cash's webhook
 *   SETTLE_WEBHOOK_SECRET   a random string, part of the webhook's path
 *   SETTLE_TOKEN            bearer token the merchant app sends
 *   SETTLE_CASHOUTS_FILE    default ~/.config/nelo/cashouts.json
 *   SETTLE_MINT             the USDC mint paj.cash takes (default devnet USDC)
 *   SETTLE_PORT / SETTLE_HOST  default 8788 on 127.0.0.1
 *   NELO_FEE_USDC           Nelo's fee per cash-out, in USDC (optional)
 *
 * See docs-site/operations/relay.mdx.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileCashouts } from "./cashout.ts";
import { pajClient, PAJ_PRODUCTION, PAJ_STAGING } from "./paj/client.ts";
import { toMinor } from "./paj/decimal.ts";
import { PajPartner } from "./paj/partner.ts";
import { currentSession, fileSessionStore } from "./paj/session.ts";
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
const production = process.env.PAJ_ENV === "production";
const sessionFile = process.env.PAJ_SESSION_FILE?.trim() || join(home, "paj-session.json");
const cashoutsFile = process.env.SETTLE_CASHOUTS_FILE?.trim() || join(home, "cashouts.json");
mkdirSync(dirname(cashoutsFile), { recursive: true });

const sessions = fileSessionStore(sessionFile);
const publicUrl = required("SETTLE_PUBLIC_URL").replace(/\/+$/, "");
const webhookSecret = required("SETTLE_WEBHOOK_SECRET");
const fee = process.env.NELO_FEE_USDC?.trim();

const partner = new PajPartner({
  client: pajClient({ baseUrl: production ? PAJ_PRODUCTION : PAJ_STAGING, apiKey: required("PAJ_API_KEY") }),
  session: () => currentSession(sessions, Date.now()),
  fidelity: production ? "live" : "sandbox",
  mint: process.env.SETTLE_MINT?.trim() || "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
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
  tokenCurrency: "USDC",
  localCurrency: "NGN",
  limits: { perMerchantPerDay: 5, minTokenMinor: 1_000_000n },
});

const port = Number(process.env.SETTLE_PORT ?? "8788");
const host = process.env.SETTLE_HOST?.trim() || "127.0.0.1";
await app.listen({ port, host });
console.log(`nelo settle on http://${host}:${port} · paj.cash ${production ? "production" : "staging"} · ${partner.fidelity}`);
if (!sessions.read()) console.warn("No paj.cash session yet: run `pnpm paj:login`.");
if (!process.env.SETTLE_TOKEN) console.warn("SETTLE_TOKEN is not set: anyone who finds the URL can open cash-outs.");
