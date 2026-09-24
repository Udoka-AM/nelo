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
 *
 * This is one of **two** ways a merchant gets an account; the other is a Privy
 * embedded wallet, for merchants who have never held a key. Which one they used
 * is recorded by `account.ts`, which owns the storage for both — this module
 * keeps only the credential that is specific to MWA.
 */
import { transact } from "@solana-mobile/mobile-wallet-adapter-protocol";
import * as SecureStore from "expo-secure-store";
import { base64AddressToBase58 } from "@nelo/pay";
import { getBase64Decoder, getBase64Encoder } from "@solana/kit";
import { forget, remember, type MerchantAccount } from "./account";

/** Shown in the wallet's authorisation sheet. */
const APP_IDENTITY = {
  name: "Nelo",
  uri: "https://nelo.app",
  icon: "favicon.png",
} as const;

/** Devnet until a payout partner and real money are in play. */
const CHAIN = "solana:devnet" as const;

/** A credential: it re-authorises without prompting, so it never touches plain storage. */
const AUTH_TOKEN_KEY = "nelo.merchant.authToken";

/**
 * Ask the wallet to authorise. Returns null if the merchant declines, which is
 * an ordinary outcome and not an error worth throwing over.
 */
export async function connect(): Promise<MerchantAccount | null> {
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

  const merchant: MerchantAccount = {
    kind: "wallet",
    address: base64AddressToBase58(account.address),
    ...(account.label ? { label: account.label } : {}),
  };

  await SecureStore.setItemAsync(AUTH_TOKEN_KEY, result.auth_token);
  await remember(merchant);
  return merchant;
}

/**
 * Have the merchant's wallet sign transactions — sign only, never send. The
 * caller checks the signed bytes are what it built before anything goes out;
 * see `@nelo/redeem`'s `checkSigned`.
 *
 * One wallet session for the whole batch, so settling five vouchers is one
 * approval rather than five.
 */
export async function signTransactions(transactions: readonly Uint8Array[]): Promise<Uint8Array[]> {
  const authToken = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
  const { signed, token } = await transact(async (wallet) => {
    const auth = await wallet.authorize({
      identity: APP_IDENTITY,
      chain: CHAIN,
      ...(authToken ? { auth_token: authToken } : {}),
    });
    const result = await wallet.signTransactions({
      payloads: transactions.map((t) => base64.decode(t)),
    });
    return { signed: result.signed_payloads, token: auth.auth_token };
  });
  await SecureStore.setItemAsync(AUTH_TOKEN_KEY, token);
  return signed.map((s) => new Uint8Array(base64.encode(s)));
}

/** Kit's codecs, named for what they do here: bytes to base64 text and back. */
const base64 = {
  decode: (bytes: Uint8Array): string => getBase64Decoder().decode(bytes),
  encode: (text: string): Uint8Array => new Uint8Array(getBase64Encoder().encode(text)),
};

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
  await Promise.all([SecureStore.deleteItemAsync(AUTH_TOKEN_KEY), forget()]);
}
