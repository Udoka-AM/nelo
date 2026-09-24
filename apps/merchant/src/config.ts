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
 * So it is configurable, with the public endpoint as the default: a build with
 * no RPC configured still runs, and anyone doing a real demo can point it at
 * something with a quota.
 */
export const rpcUrl =
  process.env.EXPO_PUBLIC_SOLANA_RPC_URL?.trim() || "https://api.devnet.solana.com";
