/**
 * Fetching snapshots: every vault for the merchant's mint, plus the risk config.
 *
 * The RPC is injected as a single `(method, params) => result` function so the
 * wire shape of each call is visible and tested. The payment-detection bug in
 * `@nelo/pay` was a call the RPC rejected every time while the app swallowed
 * the error. The tests here pin the exact params instead of trusting them.
 */
import { decodeBase64, encodeBase58 } from "@nelo/voucher";
import { NELO_VAULT_PROGRAM_ID, riskConfigAddress } from "@nelo/redeem";
import {
  decodeRiskConfig,
  decodeVault,
  VAULT_DISCRIMINATOR,
  VAULT_MINT_OFFSET,
  VAULT_SPACE,
  type RiskConfigAccount,
  type VaultAccount,
} from "./accounts.ts";
import type { Snapshot } from "./cache.ts";

export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

/** A JSON-RPC client over `fetch`. Throws on transport errors and RPC errors alike. */
export function jsonRpc(url: string, fetchImpl: typeof fetch = fetch): Rpc {
  let id = 0;
  return async (method, params) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
    const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message ?? "RPC error"}`);
    return body.result;
  };
}

interface RpcAccount {
  data: [string, string];
  owner: string;
}

function accountBytes(account: RpcAccount, programId: string, what: string): Uint8Array {
  // The RPC is trusted to answer honestly, but not to have been asked the
  // right question. An account owned by another program is not ours, whatever
  // its bytes say.
  if (account.owner !== programId) throw new Error(`${what} is owned by ${account.owner}, not the vault program`);
  if (account.data[1] !== "base64") throw new Error(`${what}: expected base64 data, got ${account.data[1]}`);
  return decodeBase64(account.data[0]);
}

export interface SnapshotOptions {
  /** The settlement mint this merchant takes. Only its vaults are cached. */
  mint: string;
  /** Unix seconds. */
  now: number;
  programId?: string;
}

export interface Fetched {
  snapshot: Snapshot;
  /** Accounts that matched the filters and would not decode. Reported, not fatal. */
  skipped: { address: string; reason: string }[];
}

/**
 * Every vault for `mint`, and the risk config — a full snapshot, suitable for
 * replacing the cache's vault set.
 */
export async function fetchAll(rpc: Rpc, options: SnapshotOptions): Promise<Fetched> {
  const programId = options.programId ?? NELO_VAULT_PROGRAM_ID;
  const accounts = (await rpc("getProgramAccounts", [
    programId,
    {
      encoding: "base64",
      commitment: "confirmed",
      filters: [
        { dataSize: VAULT_SPACE },
        { memcmp: { offset: 0, bytes: encodeBase58(VAULT_DISCRIMINATOR) } },
        { memcmp: { offset: VAULT_MINT_OFFSET, bytes: options.mint } },
      ],
    },
  ])) as { pubkey: string; account: RpcAccount }[];

  const vaults: Snapshot["vaults"][number][] = [];
  const skipped: Fetched["skipped"] = [];
  for (const { pubkey, account } of accounts) {
    try {
      const decoded = decodeVault(accountBytes(account, programId, pubkey));
      if (decoded.mint !== options.mint) throw new Error(`vault mint ${decoded.mint} is not ${options.mint}`);
      vaults.push({ address: pubkey, account: decoded });
    } catch (e) {
      skipped.push({ address: pubkey, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  const risk = await fetchRiskConfig(rpc, programId);
  return { snapshot: { syncedAt: options.now, vaults, risk, full: true }, skipped };
}

/**
 * Just the named vaults: a cheap refresh of the payers a merchant is about to
 * see again, without re-downloading every vault on the platform.
 */
export async function fetchSome(
  rpc: Rpc,
  addresses: readonly string[],
  options: Omit<SnapshotOptions, "mint"> & { mint?: string },
): Promise<Fetched> {
  const programId = options.programId ?? NELO_VAULT_PROGRAM_ID;
  const result = (await rpc("getMultipleAccounts", [
    [...addresses],
    { encoding: "base64", commitment: "confirmed" },
  ])) as { value: (RpcAccount | null)[] };

  const vaults: Snapshot["vaults"][number][] = [];
  const skipped: Fetched["skipped"] = [];
  result.value.forEach((account, i) => {
    const address = addresses[i]!;
    if (account === null) {
      skipped.push({ address, reason: "no such account" });
      return;
    }
    try {
      const decoded = decodeVault(accountBytes(account, programId, address));
      if (options.mint && decoded.mint !== options.mint) {
        throw new Error(`vault mint ${decoded.mint} is not ${options.mint}`);
      }
      vaults.push({ address, account: decoded });
    } catch (e) {
      skipped.push({ address, reason: e instanceof Error ? e.message : String(e) });
    }
  });

  const risk = await fetchRiskConfig(rpc, programId);
  return { snapshot: { syncedAt: options.now, vaults, risk, full: false }, skipped };
}

async function fetchRiskConfig(rpc: Rpc, programId: string): Promise<RiskConfigAccount | null> {
  const address = riskConfigAddress(programId);
  const result = (await rpc("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }])) as {
    value: RpcAccount | null;
  };
  if (result.value === null) return null;
  return decodeRiskConfig(accountBytes(result.value, programId, "risk config"));
}

export type { VaultAccount };
