/**
 * Nelo voucher v1 — 202 bytes, little-endian, fixed layout, no optional fields.
 * Bytes 0..105 are the message signed by the device secure element (P-256).
 *
 *   off  len  field
 *     0    1  version           u8   = 1
 *     1   32  vault             Pubkey
 *    33    8  seq               u64   monotonic per vault
 *    41    8  amount            u64   token base units (USDC = 6dp)
 *    49    8  remainingAfter    u64   payer's claimed balance after this voucher
 *    57   32  merchant          Pubkey
 *    89    8  expiresAt         i64   unix seconds
 *    97    8  salt              [u8;8]
 *   105   64  signature         [u8;64]  P-256 r||s
 *   169   33  devicePubkey      [u8;33]  SEC1 compressed
 */
export const VOUCHER_VERSION = 1;
export const SIGNED_LEN = 105;
export const VOUCHER_LEN = 202;

export interface Voucher {
  version: number;
  vault: Uint8Array;          // 32
  seq: bigint;
  amount: bigint;
  remainingAfter: bigint;
  merchant: Uint8Array;       // 32
  expiresAt: bigint;
  salt: Uint8Array;           // 8
  signature: Uint8Array;      // 64
  devicePubkey: Uint8Array;   // 33
}

export function encode(_v: Voucher): Uint8Array {
  throw new Error("TODO week 1: implement encode + golden vectors shared with the Rust side");
}

export function decode(_bytes: Uint8Array): Voucher {
  throw new Error("TODO week 1: implement decode with strict length and version checks");
}

export function verify(_v: Voucher): boolean {
  throw new Error("TODO week 1: P-256 verify over bytes 0..105 using @noble/curves");
}
