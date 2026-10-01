/**
 * Checks before the wallet is asked to sign.
 *
 * A wallet that simulates a transaction and finds it would fail says only
 * "simulation failed", which tells a payer nothing they can act on. Every way
 * opening or funding a vault can fail on chain is something the app can see
 * first: not enough devnet SOL for the rent and fee, not enough USDC for the
 * deposit, or a program error the chain would return. So the app looks, and
 * says which.
 *
 * Read-only throughout. Nothing here signs or sends.
 */
import { fetchTokenBalance, formatDollars } from "@nelo/pay";
import { encodeBase64 } from "@nelo/voucher";
import { rpc as endpoint, USDC_DEVNET } from "./config";
import { rpc } from "./rpc";

/** A little larger than the vault account, so the estimate errs high. */
const VAULT_BYTES = 256;
/** An SPL token account. */
const TOKEN_ACCOUNT_BYTES = 165;
/** Fees, with room for a priority fee the wallet may add. */
const FEE_LAMPORTS = 100_000n;

const sol = (lamports: bigint) => (Number(lamports) / 1e9).toFixed(4).replace(/0+$/, "").replace(/\.$/, "");

async function lamportsOf(owner: string): Promise<bigint> {
  const r = await rpc<{ value: number }>("getBalance", [owner, { commitment: "confirmed" }]);
  return BigInt(r.value);
}

async function rentFor(bytes: number): Promise<bigint> {
  return BigInt(await rpc<number>("getMinimumBalanceForRentExemption", [bytes]));
}

/** Null when the wallet can pay; otherwise what to tell the payer. */
export async function checkFunds(
  owner: string,
  opts: { opening: boolean; usdc: bigint },
): Promise<string | null> {
  const needSol =
    FEE_LAMPORTS + (opts.opening ? (await rentFor(VAULT_BYTES)) + (await rentFor(TOKEN_ACCOUNT_BYTES)) : 0n);
  const haveSol = await lamportsOf(owner);
  if (haveSol < needSol) {
    return `Your wallet needs about ${sol(needSol)} devnet SOL ${opts.opening ? "to open the vault" : "for the fee"} and has ${sol(haveSol)}. Get some at faucet.solana.com, then try again.`;
  }
  if (opts.usdc > 0n) {
    const haveUsdc = await fetchTokenBalance(endpoint, owner, USDC_DEVNET);
    if (haveUsdc < opts.usdc) {
      return `Your wallet has ${formatDollars(haveUsdc)} of devnet USDC, less than the ${formatDollars(opts.usdc)} you are setting aside. Set aside less, or add USDC at faucet.circle.com (Solana Devnet).`;
    }
  }
  return null;
}

/**
 * Run the transaction past the chain without signatures. Null when it would
 * succeed; otherwise the reason, from the program's own logs.
 */
export async function simulate(wire: Uint8Array): Promise<string | null> {
  const r = await rpc<{ value: { err: unknown; logs: string[] | null } }>("simulateTransaction", [
    encodeBase64(wire),
    { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" },
  ]);
  if (r.value.err === null) return null;
  return explain(r.value.err, r.value.logs ?? []);
}

/** The failure in words, most specific first. Exported for tests. */
export function explain(err: unknown, logs: readonly string[]): string {
  const all = logs.join("\n");
  if (/insufficient funds/i.test(all)) {
    return "Your wallet does not have enough devnet USDC for this. Set aside less, or add USDC at faucet.circle.com (Solana Devnet).";
  }
  if (/insufficient lamports|no record of a prior credit/i.test(all) || /InsufficientFundsForRent|AccountNotFound/.test(JSON.stringify(err))) {
    return "Your wallet does not have enough devnet SOL for the rent and fee. Get some at faucet.solana.com, then try again.";
  }
  if (/already in use/i.test(all)) {
    return "This wallet already has a vault on chain. Use a different wallet, or the phone that opened it.";
  }
  const anchor = logs.find((l) => /AnchorError|Error Message|custom program error/i.test(l));
  const detail = anchor ? anchor.replace(/^Program log:\s*/, "") : JSON.stringify(err);
  return `The network would refuse this: ${detail.slice(0, 220)}`;
}
