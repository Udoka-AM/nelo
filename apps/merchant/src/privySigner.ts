/**
 * Signing a cash-out with a Privy embedded wallet.
 *
 * Privy's Solana provider signs transactions as `@solana/web3.js` objects,
 * which this app does not carry. It also signs messages, and a transaction's
 * signature is exactly a signature over its message bytes, so that is used
 * instead. `messageSigner` checks the result against the merchant's key
 * before it goes anywhere, so a wallet that signed anything else is caught
 * here rather than on chain.
 */
import { useEmbeddedSolanaWallet } from "@privy-io/expo";
import { messageSigner, type TransactionSigner } from "@nelo/cashout";

export function usePrivySigner(owner: string): TransactionSigner | null {
  const solana = useEmbeddedSolanaWallet();
  if (solana.status !== "connected") return null;
  const wallet = solana.wallets?.[0];
  if (!wallet) return null;
  return messageSigner(owner, async (message) => {
    const provider = await wallet.getProvider();
    const { signature } = await provider.request({ method: "signMessage", params: { message } });
    return signature;
  });
}
