/**
 * The payer's own wallet, over Mobile Wallet Adapter. It owns the vault and
 * pays for opening it and for deposits. It never signs a voucher: those are
 * signed by the phone's secure element, which is the whole point of the design.
 */
import { transact } from "@solana-mobile/mobile-wallet-adapter-protocol";
import * as SecureStore from "expo-secure-store";
import { getBase64Decoder, getBase64Encoder } from "@solana/kit";
import { encodeBase58 } from "@nelo/voucher";

const APP_IDENTITY = { name: "Nelo", uri: "https://nelo.app", icon: "favicon.png" } as const;
const CHAIN = "solana:devnet" as const;
const AUTH_TOKEN_KEY = "nelo.payer.authToken";

const toBase64 = (bytes: Uint8Array) => getBase64Decoder().decode(bytes);
const fromBase64 = (text: string) => new Uint8Array(getBase64Encoder().encode(text));

/** The wallet's address, base58, or null if the payer declined. */
export async function connect(): Promise<string | null> {
  const authToken = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
  const result = await transact((wallet) =>
    wallet.authorize({ identity: APP_IDENTITY, chain: CHAIN, ...(authToken ? { auth_token: authToken } : {}) }),
  );
  const account = result.accounts[0];
  if (!account) return null;
  await SecureStore.setItemAsync(AUTH_TOKEN_KEY, result.auth_token);
  return encodeBase58(fromBase64(account.address));
}

/**
 * Sign and send, by the wallet. Unlike a redemption, these transactions do not
 * care where a priority-fee instruction lands, so the wallet is free to add
 * one. Returns the transaction signatures, base58.
 */
export async function signAndSend(transactions: readonly Uint8Array[]): Promise<string[]> {
  const authToken = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
  const { signatures, token } = await transact(async (wallet) => {
    const auth = await wallet.authorize({
      identity: APP_IDENTITY,
      chain: CHAIN,
      ...(authToken ? { auth_token: authToken } : {}),
    });
    const sent = await wallet.signAndSendTransactions({ payloads: transactions.map(toBase64) });
    return { signatures: sent.signatures, token: auth.auth_token };
  });
  await SecureStore.setItemAsync(AUTH_TOKEN_KEY, token);
  return signatures.map((s) => encodeBase58(fromBase64(s)));
}
