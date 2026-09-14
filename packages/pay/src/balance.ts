/**
 * What the merchant is holding.
 *
 * The plan is deliberate about this (docs/BUILD.md §3):
 *
 *   > The balance is displayed in local currency, held in dollars. A merchant in
 *   > a devaluing currency who holds value overnight is better off in a dollar
 *   > asset converted at payout than in a local-currency one. They see the
 *   > familiar number without the exposure.
 *
 * So the number on screen is naira and the asset underneath is USDC, and the
 * conversion happens at display time at whatever the rate is now. That is not a
 * presentation detail — it is the product decision — so the screen has to say
 * both, and the conversion has to round **down**. A balance that reads higher
 * than what is actually there is the one rounding error a merchant will
 * definitely notice, at the worst possible moment.
 *
 * Reading the balance uses `getTokenAccountsByOwner` rather than deriving an
 * associated token address: the RPC takes an owner and a mint directly, so
 * there is no address derivation to get wrong, and it picks up any token
 * account the merchant holds for that mint rather than only the canonical one.
 */
import { rpc } from "./rpc.ts";

/** The slice of a `jsonParsed` token account this needs. */
export interface ParsedTokenAccount {
  account?: {
    data?: {
      parsed?: {
        info?: {
          mint?: string;
          owner?: string;
          tokenAmount?: { amount?: string };
        };
      };
    };
  };
}

/**
 * Total held across every token account for one mint.
 *
 * Deliberately forgiving. A till showing a stale balance is a nuisance; a till
 * that throws while the merchant is mid-sale is a broken terminal. So a
 * malformed entry is skipped rather than fatal.
 *
 * The mint is re-checked here even though the RPC was asked to filter by it.
 * Trusting a filter you did not verify is how a merchant ends up looking at a
 * balance denominated in something else.
 */
export function sumTokenAccounts(
  accounts: readonly ParsedTokenAccount[] | null | undefined,
  mint: string,
): bigint {
  let total = 0n;
  for (const entry of accounts ?? []) {
    const info = entry?.account?.data?.parsed?.info;
    if (!info || info.mint !== mint) continue;
    const amount = info.tokenAmount?.amount;
    if (typeof amount !== "string") continue;
    try {
      total += BigInt(amount);
    } catch {
      // A non-numeric amount is a malformed response, not a zero balance —
      // but it is still not worth taking the screen down for.
      continue;
    }
  }
  return total;
}

/**
 * The merchant's balance for one mint, in token base units.
 *
 * A merchant who has never been paid has no token account at all, and the RPC
 * returns an empty list rather than an error. That is a zero balance, not a
 * failure — it is what every merchant's first screen looks like.
 */
export async function fetchTokenBalance(
  rpcUrl: string,
  owner: string,
  mint: string,
): Promise<bigint> {
  const result = await rpc<{ value?: ParsedTokenAccount[] }>(
    rpcUrl,
    "getTokenAccountsByOwner",
    [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }],
  );
  return sumTokenAccounts(result?.value, mint);
}
