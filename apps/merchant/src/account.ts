/**
 * The merchant's account, however they got one.
 *
 * There are two ways in, and the rest of the till does not care which:
 *
 * - **Mobile Wallet Adapter** — the merchant authorises with a wallet they
 *   already control. Required by the hackathon rules, and the honest default.
 * - **A Privy embedded wallet** — created behind an SMS code, so a merchant who
 *   has never held a private key can still be paid. This is step 2's
 *   done-when: *setup completed without ever seeing a key.*
 *
 * Privy is **additive**. It does not replace MWA, and the connect path stays
 * the first thing offered to anyone who already has a wallet.
 *
 * Everything the till needs from either is an address to be paid at, so that is
 * what this module stores, alongside how it was obtained — because the two
 * differ in one way that matters later: an MWA wallet can sign, and an embedded
 * one signs through Privy's provider.
 *
 * Which is also why a restored embedded account is usable even when Privy's
 * session has since lapsed: receiving a payment needs an address, not a
 * signature. That stops being true when the payout leg lands, and at that point
 * a lapsed session has to be detected rather than assumed away.
 */
import * as SecureStore from "expo-secure-store";

export type AccountKind = "wallet" | "embedded";

export interface MerchantAccount {
  kind: AccountKind;
  /** base58, ready to drop into a Solana Pay request. */
  address: string;
  label?: string;
  /**
   * Where takings are paid out, in `@nelo/onboard`'s canonical form —
   * `bank:NG:058:0123456789`. Present only for merchants who went through
   * onboarding; an MWA merchant settles to their own wallet.
   */
  payout?: string;
}

/**
 * One key, one JSON value. Three keys meant three ways to be half-written; a
 * single value is either there and complete or absent.
 */
const ACCOUNT_KEY = "nelo.merchant.account";

/**
 * Base58 has no `0`, `O`, `I` or `l`, and a Solana address is 32 bytes, which
 * encodes to 32–44 characters.
 */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function remember(account: MerchantAccount): Promise<void> {
  await SecureStore.setItemAsync(ACCOUNT_KEY, JSON.stringify(account));
}

/**
 * The remembered account, so the till opens ready to trade.
 *
 * Validates rather than trusts. A stored value that has been truncated, or
 * written by an older build with a different shape, must not turn into a
 * Solana Pay request paying an address that is not the merchant's — a corrupt
 * store should cost a re-connect, not a day's takings.
 */
export async function restore(): Promise<MerchantAccount | null> {
  const raw = await SecureStore.getItemAsync(ACCOUNT_KEY);
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const { kind, address, label, payout } = record;

  if (kind !== "wallet" && kind !== "embedded") return null;
  if (typeof address !== "string" || !BASE58_ADDRESS.test(address)) return null;

  return {
    kind,
    address,
    ...(typeof label === "string" ? { label } : {}),
    ...(typeof payout === "string" ? { payout } : {}),
  };
}

export async function forget(): Promise<void> {
  await SecureStore.deleteItemAsync(ACCOUNT_KEY);
}
