/**
 * Mobile Wallet Adapter — the merchant's own wallet.
 *
 * MWA is a hard requirement of the hackathon rules, but it is also the honest
 * design: Nelo never holds the merchant's key. The merchant authorises with a
 * wallet they already control, and Nelo learns only an address to be paid at.
 *
 * `transact` opens an Android intent to the wallet app, so none of this can run
 * in Expo Go or on a simulator — it needs a development build on a real device
 * with a wallet installed.
 */
import { transact } from "@solana-mobile/mobile-wallet-adapter-protocol";
import * as SecureStore from "expo-secure-store";
import { base64AddressToBase58 } from "@nelo/pay";

/** Shown in the wallet's authorisation sheet. */
const APP_IDENTITY = {
  name: "Nelo",
  uri: "https://nelo.app",
  icon: "favicon.png",
} as const;

/** Devnet until a payout partner and real money are in play. */
const CHAIN = "solana:devnet" as const;

const ADDRESS_KEY = "nelo.merchant.address";
const LABEL_KEY = "nelo.merchant.label";
/** A credential: it re-authorises without prompting, so it never touches plain storage. */
const AUTH_TOKEN_KEY = "nelo.merchant.authToken";

export interface MerchantWallet {
  /** base58 — ready to drop into a Solana Pay request. */
  address: string;
  label?: string;
}

/**
 * Ask the wallet to authorise. Returns null if the merchant declines, which is
 * an ordinary outcome and not an error worth throwing over.
 */
export async function connect(): Promise<MerchantWallet | null> {
  const authToken = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);

  const result = await transact(async (wallet) => {
    return wallet.authorize({
      identity: APP_IDENTITY,
      chain: CHAIN,
      // Re-uses a prior grant when there is one, so a returning merchant is not
      // asked to approve again on every open.
      ...(authToken ? { auth_token: authToken } : {}),
    });
  });

  const account = result.accounts[0];
  if (!account) return null;

  const merchant: MerchantWallet = {
    address: base64AddressToBase58(account.address),
    label: account.label,
  };

  await SecureStore.setItemAsync(AUTH_TOKEN_KEY, result.auth_token);
  await SecureStore.setItemAsync(ADDRESS_KEY, merchant.address);
  if (merchant.label) await SecureStore.setItemAsync(LABEL_KEY, merchant.label);
  return merchant;
}

/** The remembered wallet, so the terminal opens ready to trade. */
export async function restore(): Promise<MerchantWallet | null> {
  const address = await SecureStore.getItemAsync(ADDRESS_KEY);
  if (!address) return null;
  const label = await SecureStore.getItemAsync(LABEL_KEY);
  return { address, label: label ?? undefined };
}

export async function disconnect(): Promise<void> {
  const authToken = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
  if (authToken) {
    // Best effort: tell the wallet to drop the grant. If the wallet is gone,
    // clearing our own side is still the right outcome.
    try {
      await transact(async (wallet) => wallet.deauthorize({ auth_token: authToken }));
    } catch {
      // ignored deliberately
    }
  }
  await Promise.all([
    SecureStore.deleteItemAsync(AUTH_TOKEN_KEY),
    SecureStore.deleteItemAsync(ADDRESS_KEY),
    SecureStore.deleteItemAsync(LABEL_KEY),
  ]);
}
