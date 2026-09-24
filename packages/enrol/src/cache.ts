/**
 * The merchant's cached view of every vault it might be paid from, and of the
 * risk parameters that set their limits.
 *
 * This is the "enrolment list" the offline check leans on. A payer who walks up
 * in a dead zone can only be verified against a device key the merchant
 * already has, so the cache holds every vault for the merchant's mint, not just
 * the payers it has met.
 *
 * It doubles as the revocation list. A vault frozen by a conflict proof comes
 * back from the chain with `status = 1`, and `@nelo/accept` turns that into a
 * named risk on every voucher from it.
 *
 * Pure: snapshots in, cache out. The RPC calls are `sync.ts`'s.
 */
import type { Enrolment, RiskParams } from "@nelo/accept";
import type { RiskConfigAccount, VaultAccount } from "./accounts.ts";

export interface EnrolmentCache {
  vaults: ReadonlyMap<string, Enrolment>;
  risk: RiskParams | null;
  /** Unix seconds of the last sync that saw the risk config. */
  riskSyncedAt: number | null;
  /** Unix seconds of the last full sync, which is also the revocation list's age. */
  fullSyncAt: number | null;
}

export function emptyCache(): EnrolmentCache {
  return { vaults: new Map(), risk: null, riskSyncedAt: null, fullSyncAt: null };
}

export interface Snapshot {
  /** Unix seconds, the phone's clock when the snapshot was fetched. */
  syncedAt: number;
  vaults: readonly { address: string; account: VaultAccount }[];
  risk: RiskConfigAccount | null;
  /**
   * Every vault for the mint, rather than a chosen few. A full snapshot
   * replaces the set, so a vault that has gone from the chain goes from the
   * cache. A partial one only updates what it names.
   */
  full: boolean;
}

export function toEnrolment(address: string, v: VaultAccount, syncedAt: number): Enrolment {
  return {
    vault: address,
    devicePubkey: v.devicePubkey,
    mint: v.mint,
    balance: v.balance,
    floorLimit: v.floorLimit,
    stake: v.stake,
    pendingUnstake: v.pendingUnstake,
    reputationBps: v.reputationBps,
    seqBase: v.seqBase,
    seqBitmap: v.seqBitmap,
    status: v.status,
    syncedAt,
  };
}

export function toRiskParams(r: RiskConfigAccount): RiskParams {
  return {
    kBps: r.kBps,
    stakeReference: r.stakeReference,
    hardCap: r.hardCap,
    stakePrice: r.stakePrice,
    haircutBps: r.haircutBps,
  };
}

/**
 * Fold a snapshot into the cache. Never lets an older reading overwrite a newer
 * one: two syncs can finish out of order on a flaky connection, and the late
 * one must not roll a vault's replay window or frozen status backwards.
 */
export function applySnapshot(cache: EnrolmentCache, s: Snapshot): EnrolmentCache {
  const vaults = new Map(s.full ? [] : cache.vaults);
  if (s.full) {
    // Keep anything the cache read more recently than this snapshot did.
    for (const [address, e] of cache.vaults) if (e.syncedAt > s.syncedAt) vaults.set(address, e);
  }
  for (const { address, account } of s.vaults) {
    const held = vaults.get(address) ?? cache.vaults.get(address);
    if (held && held.syncedAt > s.syncedAt) {
      vaults.set(address, held);
      continue;
    }
    vaults.set(address, toEnrolment(address, account, s.syncedAt));
  }

  const newerRisk = s.risk !== null && (cache.riskSyncedAt === null || s.syncedAt >= cache.riskSyncedAt);
  return {
    vaults,
    risk: newerRisk ? toRiskParams(s.risk!) : cache.risk,
    riskSyncedAt: newerRisk ? s.syncedAt : cache.riskSyncedAt,
    fullSyncAt: s.full && (cache.fullSyncAt === null || s.syncedAt > cache.fullSyncAt) ? s.syncedAt : cache.fullSyncAt,
  };
}

export type Lookup =
  | { found: true; enrolment: Enrolment; risk: RiskParams }
  /**
   * Nothing to check against. `@nelo/accept` cannot run, and the till must
   * say so rather than guess: a vault it has never seen is indistinguishable,
   * offline, from one that does not exist.
   */
  | { found: false; missing: "vault" | "risk" };

export function lookup(cache: EnrolmentCache, vault: string): Lookup {
  if (cache.risk === null) return { found: false, missing: "risk" };
  const enrolment = cache.vaults.get(vault);
  if (!enrolment) return { found: false, missing: "vault" };
  return { found: true, enrolment, risk: cache.risk };
}

// ---- storage ----

export interface CacheRecord {
  vaults: Record<string, Record<string, string | number>>;
  risk: Record<string, string | number> | null;
  riskSyncedAt: number | null;
  fullSyncAt: number | null;
}

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toRecord(c: EnrolmentCache): CacheRecord {
  const vaults: CacheRecord["vaults"] = {};
  for (const [address, e] of c.vaults) {
    vaults[address] = {
      vault: e.vault,
      devicePubkey: hex(e.devicePubkey),
      mint: e.mint,
      balance: e.balance.toString(),
      floorLimit: e.floorLimit.toString(),
      stake: e.stake.toString(),
      pendingUnstake: e.pendingUnstake.toString(),
      reputationBps: e.reputationBps,
      seqBase: e.seqBase.toString(),
      seqBitmap: e.seqBitmap.toString(),
      status: e.status,
      syncedAt: e.syncedAt,
    };
  }
  return {
    vaults,
    risk: c.risk && {
      kBps: c.risk.kBps,
      stakeReference: c.risk.stakeReference.toString(),
      hardCap: c.risk.hardCap.toString(),
      stakePrice: c.risk.stakePrice.toString(),
      haircutBps: c.risk.haircutBps,
    },
    riskSyncedAt: c.riskSyncedAt,
    fullSyncAt: c.fullSyncAt,
  };
}

export function fromRecord(r: CacheRecord): EnrolmentCache {
  const vaults = new Map<string, Enrolment>();
  for (const [address, v] of Object.entries(r.vaults)) {
    vaults.set(address, {
      vault: String(v.vault),
      devicePubkey: unhex(String(v.devicePubkey)),
      mint: String(v.mint),
      balance: BigInt(v.balance!),
      floorLimit: BigInt(v.floorLimit!),
      stake: BigInt(v.stake!),
      pendingUnstake: BigInt(v.pendingUnstake!),
      reputationBps: Number(v.reputationBps),
      seqBase: BigInt(v.seqBase!),
      seqBitmap: BigInt(v.seqBitmap!),
      status: Number(v.status),
      syncedAt: Number(v.syncedAt),
    });
  }
  return {
    vaults,
    risk: r.risk && {
      kBps: Number(r.risk.kBps),
      stakeReference: BigInt(r.risk.stakeReference!),
      hardCap: BigInt(r.risk.hardCap!),
      stakePrice: BigInt(r.risk.stakePrice!),
      haircutBps: Number(r.risk.haircutBps),
    },
    riskSyncedAt: r.riskSyncedAt,
    fullSyncAt: r.fullSyncAt,
  };
}
