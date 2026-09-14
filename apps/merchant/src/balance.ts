/**
 * The merchant's balance, as they should see it.
 *
 * Held in dollars, shown in naira — the decision in docs/BUILD.md §3, and the
 * reason it is a decision rather than a formatting choice:
 *
 *   > A merchant in a devaluing currency who holds value overnight is better
 *   > off in a dollar asset converted at payout than in a local-currency one.
 *   > They see the familiar number without the exposure.
 *
 * Which means the screen owes them two facts, not one: the familiar number, and
 * that the thing underneath it is dollars. Showing only the naira figure would
 * be the same trick as showing a made-up exchange rate — technically what they
 * asked for, quietly not what is true.
 */
import { fetchTokenBalance, tokenBaseUnitsToLocalMinor, type Rate } from "@nelo/pay";

export interface Balance {
  /** What is actually held, in token base units. */
  baseUnits: bigint;
  /** The same value in the merchant's currency, rounded down. */
  localMinor: bigint;
  /** False when the rate behind the local figure is not a live one. */
  liveRate: boolean;
}

/**
 * Read it.
 *
 * Returns a zero balance rather than throwing when the merchant has never been
 * paid — that is the ordinary first-run state, not an error worth a dialog.
 * A genuine RPC failure does throw, so the caller can leave the previous figure
 * on screen rather than replacing it with a confident zero.
 */
export async function currentBalance(
  rpcUrl: string,
  merchantAddress: string,
  mint: string,
  rate: Rate,
  liveRate: boolean,
): Promise<Balance> {
  const baseUnits = await fetchTokenBalance(rpcUrl, merchantAddress, mint);
  return {
    baseUnits,
    localMinor: tokenBaseUnitsToLocalMinor(baseUnits, rate),
    liveRate,
  };
}
