/**
 * Build-time configuration, and what to do when it is absent.
 *
 * A Privy app ID is a **public** identifier — it ships inside the APK, and
 * every request already carries it. It is not a secret and is not treated as
 * one. What must never be here is a Privy *app secret*, which belongs on a
 * server and nowhere near this bundle.
 *
 * `EXPO_PUBLIC_` is the prefix Expo inlines into the client bundle, which is
 * exactly the semantics wanted: whatever is named this way is understood to be
 * public.
 *
 * ## Absent is a supported state, not a crash
 *
 * This repository has no Privy app ID and must not acquire one. So a build
 * without it works: the embedded path is simply not offered, and Mobile Wallet
 * Adapter — which is what the hackathon rules require anyway — carries the app
 * on its own. A missing app ID that took the terminal down with it would make
 * the till un-runnable for the sake of an optional route into it.
 */
import { endpointsFrom, failover } from "@nelo/rpc";
const appId = process.env.EXPO_PUBLIC_PRIVY_APP_ID?.trim();
const clientId = process.env.EXPO_PUBLIC_PRIVY_CLIENT_ID?.trim();

export interface PrivyConfig {
  appId: string;
  clientId?: string;
}

/** The Privy configuration, or null when this build has none. */
export const privy: PrivyConfig | null = appId
  ? { appId, ...(clientId ? { clientId } : {}) }
  : null;

/**
 * Whether to offer "set up with your phone number" at all.
 *
 * Offering it without an app ID would put a button on screen that can only
 * fail, and the failure would land on the merchant as though they had done
 * something wrong.
 */
export const canOnboardWithPhone = privy !== null;

/**
 * Which RPC the till talks to.
 *
 * `api.devnet.solana.com` is the public endpoint and it rate-limits hard. That
 * was survivable while the terminal polled a malformed request nobody could
 * see; now that detection actually works and polls every couple of seconds for
 * as long as a code is on screen, a shared public endpoint is the next thing to
 * fail — and it fails as 429s, which look exactly like a customer who has not
 * paid yet.
 *
 * So it is configurable, with fallbacks: the preferred endpoint first, then
 * `EXPO_PUBLIC_SOLANA_RPC_FALLBACK_URLS` (comma-separated), then the public
 * endpoint as a last resort. A request moves on only when an endpoint did not
 * answer; see `@nelo/rpc`. Devnet throughout, so the last resort is devnet's.
 */
export const rpc = failover(
  endpointsFrom(
    process.env.EXPO_PUBLIC_SOLANA_RPC_URL,
    process.env.EXPO_PUBLIC_SOLANA_RPC_FALLBACK_URLS,
    "https://api.devnet.solana.com",
  ),
);

/**
 * Nelo's relayer: it submits the till's offline vouchers and pays the fees, so
 * a merchant settles with no SOL and nothing to sign, whichever way they signed
 * up. See services/relay.
 *
 * The token is not a secret from anyone holding the APK. It keeps casual
 * traffic off the endpoint; the relayer's own policy is what bounds its spend.
 */
export const relayUrl = process.env.EXPO_PUBLIC_NELO_RELAY_URL?.trim().replace(/\/+$/, "") || null;
export const relayToken = process.env.EXPO_PUBLIC_NELO_RELAY_TOKEN?.trim() || null;

/**
 * Nelo's settlement service: cash-outs to a bank through paj.cash, and
 * paj.cash's naira rate. See services/settle. Like the relayer's, the token is
 * not a secret from anyone holding the APK; paj.cash's own key never leaves
 * the server.
 */
export const settleUrl = process.env.EXPO_PUBLIC_NELO_SETTLE_URL?.trim().replace(/\/+$/, "") || null;
export const settleToken = process.env.EXPO_PUBLIC_NELO_SETTLE_TOKEN?.trim() || null;
