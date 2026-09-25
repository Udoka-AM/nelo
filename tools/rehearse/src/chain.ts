/**
 * The few things a rehearsal needs from a cluster that the apps never do
 * themselves: keypairs held in memory, transactions with more than one signer,
 * waiting for confirmation, and the SPL and program instructions only a test
 * sets up with (a mint, minting, the risk config, staking).
 *
 * Everything that the product itself does on chain is *not* here. The vault
 * is opened with `@nelo/redeem`'s builders, the voucher is issued by
 * `@nelo/issue`, taken by `@nelo/till`, settled by `@nelo/queue` through the
 * relayer in `services/relay`. This file only makes the world they run in.
 */
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import {
  AccountRole,
  associatedTokenAddress,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  buildTransaction,
  NELO_VAULT_PROGRAM_ID,
  riskConfigAddress,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  vaultAddress,
  withSignature,
  type Instruction,
} from "@nelo/redeem";
import { decodeBase58, decodeBase64, encodeBase58, encodeBase64 } from "@nelo/voucher";

const addressBytes = (address: string) => decodeBase58(address);

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export interface Keypair {
  address: string;
  secret: Uint8Array;
  sign(message: Uint8Array): Uint8Array;
}

export function keypairFromSecret(secret: Uint8Array): Keypair {
  const pub = ed25519.getPublicKey(secret);
  return { address: encodeBase58(pub), secret, sign: (m) => ed25519.sign(m, secret) };
}

export const newKeypair = (): Keypair => keypairFromSecret(ed25519.utils.randomPrivateKey());

/** A `solana-keygen` file: a JSON array of 64 bytes, secret ‖ public. */
export function loadKeypair(path: string): Keypair {
  const bytes = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]);
  if (bytes.length !== 64) throw new Error(`${path} is not a Solana keypair file`);
  const kp = keypairFromSecret(bytes.slice(0, 32));
  if (kp.address !== encodeBase58(bytes.slice(32))) throw new Error(`${path}: public half does not match`);
  return kp;
}

/** The whole 64-byte form, as `feePayerFromSecret` in the relayer takes it. */
export const keypairBytes = (k: Keypair) => concat(k.secret, addressBytes(k.address));

// ---------------------------------------------------------------------------
// JSON-RPC

export class RpcError extends Error {
  readonly err: unknown;
  readonly logs: readonly string[];
  constructor(message: string, err: unknown, logs: readonly string[]) {
    super(message);
    this.err = err;
    this.logs = logs;
  }
}

export interface Cluster {
  url: string;
  call<T>(method: string, params?: unknown[]): Promise<T>;
  /** Sign with every signer, send, and wait for `confirmed`. Returns the signature. */
  send(instructions: readonly Instruction[], signers: readonly Keypair[]): Promise<string>;
  /** Send without waiting, returning the transaction error from preflight if any. */
  trySend(instructions: readonly Instruction[], signers: readonly Keypair[]): Promise<{ ok: true; signature: string } | { ok: false; err: unknown; logs: readonly string[] }>;
  confirm(signature: string, timeoutMs?: number): Promise<void>;
  lamports(address: string): Promise<number>;
  account(address: string): Promise<Uint8Array | null>;
  tokenBalance(address: string): Promise<bigint>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function cluster(url: string): Cluster {
  let id = 0;
  async function raw<T>(method: string, params: unknown[] = []) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
    return (await response.json()) as {
      result?: T;
      error?: { message?: string; data?: { err?: unknown; logs?: string[] } };
    };
  }
  async function call<T>(method: string, params: unknown[] = []): Promise<T> {
    const body = await raw<T>(method, params);
    if (body.error) throw new RpcError(`${method}: ${body.error.message ?? "RPC error"}`, body.error.data?.err, body.error.data?.logs ?? []);
    return body.result as T;
  }

  async function signed(instructions: readonly Instruction[], signers: readonly Keypair[]) {
    const { value } = await call<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [
      { commitment: "confirmed" },
    ]);
    const unsigned = buildTransaction(instructions, signers[0]!.address, {
      blockhash: value.blockhash,
      lastValidBlockHeight: BigInt(value.lastValidBlockHeight),
    });
    let wire = unsigned.wire;
    for (const s of signers) wire = withSignature(wire, s.address, s.sign(unsigned.message));
    return { wire, signature: encodeBase58(signers[0]!.sign(unsigned.message)) };
  }

  async function confirm(signature: string, timeoutMs = 60_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const { value } = await call<{ value: ({ err: unknown; confirmationStatus: string | null } | null)[] }>(
        "getSignatureStatuses",
        [[signature], { searchTransactionHistory: true }],
      );
      const s = value[0];
      if (s?.err) throw new RpcError(`${signature} failed: ${JSON.stringify(s.err)}`, s.err, []);
      if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return;
      await sleep(500);
    }
    throw new Error(`${signature} was not confirmed within ${timeoutMs / 1000}s`);
  }

  async function trySend(instructions: readonly Instruction[], signers: readonly Keypair[]) {
    const { wire, signature } = await signed(instructions, signers);
    const body = await raw<string>("sendTransaction", [
      encodeBase64(wire),
      { encoding: "base64", preflightCommitment: "confirmed" },
    ]);
    if (!body.error) return { ok: true as const, signature };
    if (body.error.data?.err !== undefined && body.error.data?.err !== null) {
      return { ok: false as const, err: body.error.data.err, logs: body.error.data.logs ?? [] };
    }
    throw new Error(`sendTransaction: ${body.error.message ?? "RPC error"}`);
  }

  async function account(address: string) {
    const { value } = await call<{ value: { data: [string, string] } | null }>("getAccountInfo", [
      address,
      { encoding: "base64", commitment: "confirmed" },
    ]);
    return value ? decodeBase64(value.data[0]) : null;
  }

  return {
    url,
    call,
    confirm,
    trySend,
    account,
    async send(instructions, signers) {
      const sent = await trySend(instructions, signers);
      if (!sent.ok) {
        throw new RpcError(`transaction refused: ${JSON.stringify(sent.err)}\n    ${sent.logs.slice(-6).join("\n    ")}`, sent.err, sent.logs);
      }
      await confirm(sent.signature);
      return sent.signature;
    },
    async lamports(address) {
      return (await call<{ value: number }>("getBalance", [address, { commitment: "confirmed" }])).value;
    },
    async tokenBalance(address) {
      const data = await account(address);
      return data && data.length >= 72 ? new DataView(data.buffer, data.byteOffset).getBigUint64(64, true) : 0n;
    },
  };
}

// ---------------------------------------------------------------------------
// System and SPL Token instructions

const u64 = (v: bigint) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
};
const u32 = (v: number) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, v, true);
  return out;
};
const u16 = (v: number) => {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, v, true);
  return out;
};
const i64 = (v: bigint) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, v, true);
  return out;
};

export const MINT_LEN = 82;

export function transfer(from: string, to: string, lamports: bigint): Instruction {
  return {
    programAddress: SYSTEM_PROGRAM_ID,
    accounts: [
      { address: from, role: AccountRole.WRITABLE_SIGNER },
      { address: to, role: AccountRole.WRITABLE },
    ],
    data: concat(u32(2), u64(lamports)),
  };
}

export function createAccount(from: string, account: string, lamports: bigint, space: number, owner: string): Instruction {
  return {
    programAddress: SYSTEM_PROGRAM_ID,
    accounts: [
      { address: from, role: AccountRole.WRITABLE_SIGNER },
      { address: account, role: AccountRole.WRITABLE_SIGNER },
    ],
    data: concat(u32(0), u64(lamports), u64(BigInt(space)), addressBytes(owner)),
  };
}

/** InitializeMint2: no rent sysvar, no freeze authority. */
export function initializeMint(mint: string, authority: string, decimals: number): Instruction {
  return {
    programAddress: TOKEN_PROGRAM_ID,
    accounts: [{ address: mint, role: AccountRole.WRITABLE }],
    data: concat(Uint8Array.of(20, decimals), addressBytes(authority), Uint8Array.of(0)),
  };
}

export function mintTo(mint: string, to: string, authority: string, amount: bigint): Instruction {
  return {
    programAddress: TOKEN_PROGRAM_ID,
    accounts: [
      { address: mint, role: AccountRole.WRITABLE },
      { address: to, role: AccountRole.WRITABLE },
      { address: authority, role: AccountRole.READONLY_SIGNER },
    ],
    data: concat(Uint8Array.of(7), u64(amount)),
  };
}

export function createAtaIdempotent(funder: string, owner: string, mint: string): Instruction {
  return {
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ID,
    accounts: [
      { address: funder, role: AccountRole.WRITABLE_SIGNER },
      { address: associatedTokenAddress(owner, mint, TOKEN_PROGRAM_ID), role: AccountRole.WRITABLE },
      { address: owner, role: AccountRole.READONLY },
      { address: mint, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
      { address: TOKEN_PROGRAM_ID, role: AccountRole.READONLY },
    ],
    data: Uint8Array.of(1),
  };
}

/** A mint's authority, or null if it has none. */
export function mintAuthority(data: Uint8Array): string | null {
  const present = new DataView(data.buffer, data.byteOffset).getUint32(0, true);
  return present ? encodeBase58(data.subarray(4, 36)) : null;
}

// ---------------------------------------------------------------------------
// nelo_vault instructions the apps never send

const discriminator = (name: string) => sha256(new TextEncoder().encode(`global:${name}`)).slice(0, 8);

export interface RiskParams {
  authority: string;
  kBps: number;
  stakeReference: bigint;
  hardCap: bigint;
  stakePrice: bigint;
  haircutBps: number;
  unstakeCooldown: bigint;
}

/** Permissionless and once only: the first caller sets the platform's risk config. */
export function initializeRiskConfig(payer: string, stakeMint: string, p: RiskParams, programId?: string): Instruction {
  return {
    programAddress: programId ?? NELO_VAULT_PROGRAM_ID,
    accounts: [
      { address: payer, role: AccountRole.WRITABLE_SIGNER },
      { address: riskConfigAddress(programId), role: AccountRole.WRITABLE },
      { address: stakeMint, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
    ],
    data: concat(
      discriminator("initialize_risk_config"),
      addressBytes(p.authority),
      u32(p.kBps),
      u64(p.stakeReference),
      u64(p.hardCap),
      u64(p.stakePrice),
      u16(p.haircutBps),
      i64(p.unstakeCooldown),
    ),
  };
}

/** Stake from the owner's own token account of the stake mint into the vault. */
export function stake(owner: string, stakeMint: string, amount: bigint, programId?: string): Instruction {
  const vault = vaultAddress(owner, programId);
  return {
    programAddress: programId ?? NELO_VAULT_PROGRAM_ID,
    accounts: [
      { address: owner, role: AccountRole.WRITABLE_SIGNER },
      { address: vault, role: AccountRole.WRITABLE },
      { address: riskConfigAddress(programId), role: AccountRole.READONLY },
      { address: stakeMint, role: AccountRole.READONLY },
      { address: associatedTokenAddress(owner, stakeMint, TOKEN_PROGRAM_ID), role: AccountRole.WRITABLE },
      { address: associatedTokenAddress(vault, stakeMint, TOKEN_PROGRAM_ID), role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM_ID, role: AccountRole.READONLY },
      { address: ASSOCIATED_TOKEN_PROGRAM_ID, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
    ],
    data: concat(discriminator("stake"), u64(amount)),
  };
}
