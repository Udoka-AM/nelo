/**
 * Refreshing the payer list while the till is online.
 *
 * Every vault for the till's mint, not just payers it has met: a customer
 * standing at the counter in a dead zone can only be checked against a key the
 * till already holds. Called on start and before a settle round, and cheap to
 * call again — the cache never lets an older reading overwrite a newer one.
 */
import { applySnapshot, fetchAll, jsonRpc, type EnrolmentCache } from "@nelo/enrol";
import { rpc } from "./config";
import { loadCache, saveCache } from "./offline";

export interface Synced {
  cache: EnrolmentCache;
  /** Accounts that matched and would not decode. Worth a log line, not a failure. */
  skipped: number;
}

/** Throws when the network is unreachable; the cached list stays as it was. */
export async function syncPayers(mint: string): Promise<Synced> {
  const { snapshot, skipped } = await fetchAll(jsonRpc(rpc.url, rpc.fetch), {
    mint,
    now: Math.floor(Date.now() / 1000),
  });
  const cache = applySnapshot(await loadCache(), snapshot);
  await saveCache(cache);
  return { cache, skipped: skipped.length };
}
