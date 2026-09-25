/**
 * Being paid by another customer, with no merchant involved.
 *
 * A voucher does not know what a merchant is. It names an address to pay,
 * and the program pays exactly that address. So a customer receives the way
 * a till does: show a code with their address and the amount, scan the
 * voucher the other phone shows, check it offline against the payer list,
 * keep it, and settle it through the relayer when there is signal. Every
 * step is the till's own code: `@nelo/till` decides and stores, `@nelo/queue`
 * settles.
 *
 * The money lands in this customer's wallet, not in their vault. Moving it
 * into the vault to spend offline is an ordinary deposit.
 */
import * as SQLite from "expo-sqlite";
import { applySnapshot, fetchAll, jsonRpc } from "@nelo/enrol";
import {
  enqueue,
  relayPrepare,
  reportConflict,
  rpcStatuses,
  settleOnce,
  type Relayer,
  type RoundReport,
} from "@nelo/queue";
import { receiveCode, scan, voucherDb, type Scan } from "@nelo/till";
import { relayToken, relayUrl, rpcUrl, USDC_DEVNET } from "./config";

const db = voucherDb(() => SQLite.openDatabaseAsync("nelo-receive.db"));

/** The code the other customer scans: this wallet, this amount, in USDC. */
export function requestCode(owner: string, amount: bigint): string {
  return receiveCode(owner, amount, USDC_DEVNET);
}

/** Check the other customer's voucher, offline. */
export async function check(text: string, owner: string, amount: bigint): Promise<Scan> {
  return scan({
    text,
    cache: await db.loadCache(),
    merchant: owner,
    charged: amount,
    queued: await db.queue.all(),
    now: Math.floor(Date.now() / 1000),
  });
}

export type Kept = { kind: "kept" } | { kind: "conflict" };

/** Keep a voucher that checked out. A second, different one at its sequence is a double spend. */
export async function keep(packet: Uint8Array): Promise<Kept> {
  const queued = await db.queue.all();
  const r = enqueue((id) => queued.find((e) => e.id === id), packet, Date.now());
  if (r.kind === "conflict") {
    await db.addConflict(r.existing.id, r.existing.packet, r.incoming);
    return { kind: "conflict" };
  }
  if (r.kind === "added") await db.add(r.entry, r.entry.amount, "USDC");
  return { kind: "kept" };
}

/** Received and not yet in the wallet. */
export async function waiting(): Promise<{ count: number; amount: bigint }> {
  const pending = (await db.queue.all()).filter((e) => e.status === "pending" || e.status === "held");
  return { count: pending.length, amount: pending.reduce((sum, e) => sum + e.amount, 0n) };
}

/** Refresh the payer list. Throws offline; the list on the phone stays. */
export async function syncPayers(): Promise<void> {
  const { snapshot } = await fetchAll(jsonRpc(rpcUrl), { mint: USDC_DEVNET, now: Math.floor(Date.now() / 1000) });
  await db.saveCache(applySnapshot(await db.loadCache(), snapshot));
}

export type Settled = { kind: "round"; report: RoundReport; conflictsReported: number } | { kind: "no-relay" };

/** Settle what this phone received, and report any double spend it caught. */
export async function settleReceived(): Promise<Settled> {
  if (!relayUrl) return { kind: "no-relay" };
  const relayer: Relayer = { url: relayUrl, ...(relayToken ? { token: relayToken } : {}) };
  const report = await settleOnce(db.queue, {
    now: () => Date.now(),
    prepare: relayPrepare(relayer),
    statuses: rpcStatuses(rpcUrl),
  });
  let conflictsReported = 0;
  if (!report.offline) {
    for (const c of await db.unreported()) {
      const outcome = await reportConflict(relayer, c.a, c.b);
      if (!outcome.done) continue;
      await db.markReported(c.id, outcome.status);
      if (outcome.status === "reported") conflictsReported++;
    }
  }
  return { kind: "round", report, conflictsReported };
}
