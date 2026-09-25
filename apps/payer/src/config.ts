/**
 * Build-time settings for the payer app. Devnet throughout until real money
 * is in play.
 */
export const rpcUrl =
  process.env.EXPO_PUBLIC_SOLANA_RPC_URL?.trim() || "https://api.devnet.solana.com";

/** Circle's devnet USDC: what the vault holds and every voucher pays in. */
export const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

/**
 * The floor limit this phone asks for at enrolment: the most one offline
 * voucher can carry before stake lifts it. $50.
 *
 * Chosen by the app, not the payer, because the program accepts whatever it is
 * given up to the platform's hard cap. See docs/DELIVERABLES.md: that is a
 * program-side gap, and the app not exposing the knob is the stopgap.
 */
export const FLOOR_LIMIT = 50_000_000n;

/** The Android Keystore alias of this phone's payment key. */
export const KEY_ALIAS = "nelo.payer.device.v1";

/**
 * Nelo's relayer, which settles payments this phone received from another
 * customer: it submits them and pays the fees. See services/relay. The token
 * is not a secret from anyone holding the APK.
 */
export const relayUrl = process.env.EXPO_PUBLIC_NELO_RELAY_URL?.trim().replace(/\/+$/, "") || null;
export const relayToken = process.env.EXPO_PUBLIC_NELO_RELAY_TOKEN?.trim() || null;
