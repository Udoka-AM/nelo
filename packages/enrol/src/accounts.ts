/**
 * `Vault` and `RiskConfig`, read straight out of account data.
 *
 * Anchor accounts are an 8-byte discriminator followed by the fields in Borsh,
 * little-endian, in declaration order, with no padding. The layout is pinned
 * by `vectors/accounts-v1.json`, which `programs/nelo_vault/tests/
 * account_vectors.rs` produces with Anchor's own serializer.
 *
 * Every read checks the discriminator. An account that is not a vault, handed
 * to a merchant as though it were one, must fail here rather than yield a
 * device key that happens to be whatever sat at byte 72.
 */
import { encodeBase58 } from "@nelo/voucher";

/** `Vault::DISCRIMINATOR`. Checked against the vectors. */
export const VAULT_DISCRIMINATOR = Uint8Array.of(0xd3, 0x08, 0xe8, 0x2b, 0x02, 0x98, 0x75, 0x77);
/** `RiskConfig::DISCRIMINATOR`. Checked against the vectors. */
export const RISK_CONFIG_DISCRIMINATOR = Uint8Array.of(0xc9, 0x77, 0xf5, 0xf4, 0x28, 0x1b, 0x00, 0x1f);
/** `8 + Vault::INIT_SPACE`: the size every vault account is allocated. */
export const VAULT_SPACE = 213;
export const RISK_CONFIG_SPACE = 111;
/** Where `mint` sits in a vault: after the discriminator and `owner`. */
export const VAULT_MINT_OFFSET = 8 + 32;

export interface VaultAccount {
  owner: string;
  mint: string;
  devicePubkey: Uint8Array;
  attestationId: Uint8Array;
  balance: bigint;
  seqBase: bigint;
  seqBitmap: bigint;
  floorLimit: bigint;
  unlockAt: bigint;
  stake: bigint;
  reputationBps: number;
  pendingUnstake: bigint;
  unstakeUnlockAt: bigint;
  status: number;
  bump: number;
}

export interface RiskConfigAccount {
  authority: string;
  stakeMint: string;
  kBps: number;
  stakeReference: bigint;
  hardCap: bigint;
  stakePrice: bigint;
  haircutBps: number;
  unstakeCooldown: bigint;
  bump: number;
}

class Reader {
  private at: number;
  private readonly view: DataView;
  private readonly data: Uint8Array;

  constructor(data: Uint8Array, start: number) {
    this.data = data;
    this.at = start;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  private need(n: number): number {
    const at = this.at;
    if (at + n > this.data.length) throw new Error(`account data ends at ${this.data.length}, needed ${at + n}`);
    this.at += n;
    return at;
  }

  bytes(n: number): Uint8Array {
    const at = this.need(n);
    return this.data.slice(at, at + n);
  }
  pubkey(): string {
    return encodeBase58(this.bytes(32));
  }
  u8(): number {
    return this.view.getUint8(this.need(1));
  }
  u16(): number {
    return this.view.getUint16(this.need(2), true);
  }
  u32(): number {
    return this.view.getUint32(this.need(4), true);
  }
  u64(): bigint {
    return this.view.getBigUint64(this.need(8), true);
  }
  i64(): bigint {
    return this.view.getBigInt64(this.need(8), true);
  }
  u128(): bigint {
    const lo = this.u64();
    const hi = this.u64();
    return (hi << 64n) | lo;
  }
}

function expectDiscriminator(data: Uint8Array, expected: Uint8Array, what: string): void {
  if (data.length < 8 || expected.some((b, i) => data[i] !== b)) {
    throw new Error(`not a ${what} account (discriminator mismatch)`);
  }
}

export function decodeVault(data: Uint8Array): VaultAccount {
  expectDiscriminator(data, VAULT_DISCRIMINATOR, "vault");
  const r = new Reader(data, 8);
  return {
    owner: r.pubkey(),
    mint: r.pubkey(),
    devicePubkey: r.bytes(33),
    attestationId: r.bytes(32),
    balance: r.u64(),
    seqBase: r.u64(),
    seqBitmap: r.u128(),
    floorLimit: r.u64(),
    unlockAt: r.i64(),
    stake: r.u64(),
    reputationBps: r.u16(),
    pendingUnstake: r.u64(),
    unstakeUnlockAt: r.i64(),
    status: r.u8(),
    bump: r.u8(),
  };
}

export function decodeRiskConfig(data: Uint8Array): RiskConfigAccount {
  expectDiscriminator(data, RISK_CONFIG_DISCRIMINATOR, "risk config");
  const r = new Reader(data, 8);
  return {
    authority: r.pubkey(),
    stakeMint: r.pubkey(),
    kBps: r.u32(),
    stakeReference: r.u64(),
    hardCap: r.u64(),
    stakePrice: r.u64(),
    haircutBps: r.u16(),
    unstakeCooldown: r.i64(),
    bump: r.u8(),
  };
}
