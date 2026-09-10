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
 *   105   64  signature         [u8;64]  P-256 r||s, low-S
 *   169   33  devicePubkey      [u8;33]  SEC1 compressed
 *
 * This layout is a contract with the on-chain program: bytes 0..105 here must
 * match `VoucherArgs::signed_message()` in programs/nelo_vault byte for byte,
 * or every signature fails verification. `vectors/voucher-v1.json` is the
 * frozen proof that they agree; both sides assert against it.
 */
import { p256 } from "@noble/curves/p256";

export const VOUCHER_VERSION = 1;
export const SIGNED_LEN = 105;
export const VOUCHER_LEN = 202;

const OFF = {
  version: 0,
  vault: 1,
  seq: 33,
  amount: 41,
  remainingAfter: 49,
  merchant: 57,
  expiresAt: 89,
  salt: 97,
  signature: 105,
  devicePubkey: 169,
} as const;

export interface Voucher {
  version: number;
  vault: Uint8Array; // 32
  seq: bigint;
  amount: bigint;
  remainingAfter: bigint;
  merchant: Uint8Array; // 32
  expiresAt: bigint;
  salt: Uint8Array; // 8
  signature: Uint8Array; // 64
  devicePubkey: Uint8Array; // 33
}

function fixed(name: string, value: Uint8Array, len: number): void {
  if (value.length !== len) {
    throw new Error(`${name} must be ${len} bytes, got ${value.length}`);
  }
}

/** The 105 bytes the secure element signs. */
export function signedMessage(v: Omit<Voucher, "signature" | "devicePubkey">): Uint8Array {
  fixed("vault", v.vault, 32);
  fixed("merchant", v.merchant, 32);
  fixed("salt", v.salt, 8);
  if (v.version !== VOUCHER_VERSION) {
    throw new Error(`unsupported voucher version ${v.version}`);
  }

  const out = new Uint8Array(SIGNED_LEN);
  const dv = new DataView(out.buffer);
  out[OFF.version] = v.version;
  out.set(v.vault, OFF.vault);
  dv.setBigUint64(OFF.seq, v.seq, true);
  dv.setBigUint64(OFF.amount, v.amount, true);
  dv.setBigUint64(OFF.remainingAfter, v.remainingAfter, true);
  out.set(v.merchant, OFF.merchant);
  dv.setBigInt64(OFF.expiresAt, v.expiresAt, true);
  out.set(v.salt, OFF.salt);
  return out;
}

export function encode(v: Voucher): Uint8Array {
  fixed("signature", v.signature, 64);
  fixed("devicePubkey", v.devicePubkey, 33);

  const out = new Uint8Array(VOUCHER_LEN);
  out.set(signedMessage(v), 0);
  out.set(v.signature, OFF.signature);
  out.set(v.devicePubkey, OFF.devicePubkey);
  return out;
}

export function decode(bytes: Uint8Array): Voucher {
  if (bytes.length !== VOUCHER_LEN) {
    throw new Error(`voucher must be ${VOUCHER_LEN} bytes, got ${bytes.length}`);
  }
  const version = bytes[OFF.version]!;
  if (version !== VOUCHER_VERSION) {
    throw new Error(`unsupported voucher version ${version}`);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    version,
    vault: bytes.slice(OFF.vault, OFF.vault + 32),
    seq: dv.getBigUint64(OFF.seq, true),
    amount: dv.getBigUint64(OFF.amount, true),
    remainingAfter: dv.getBigUint64(OFF.remainingAfter, true),
    merchant: bytes.slice(OFF.merchant, OFF.merchant + 32),
    expiresAt: dv.getBigInt64(OFF.expiresAt, true),
    salt: bytes.slice(OFF.salt, OFF.salt + 8),
    signature: bytes.slice(OFF.signature, OFF.signature + 64),
    devicePubkey: bytes.slice(OFF.devicePubkey, OFF.devicePubkey + 33),
  };
}

/**
 * Verify the device signature over bytes 0..105. This is what a merchant runs
 * with no network — it proves the voucher came from *a* enrolled secure
 * element, not that the sequence is unspent. Only the chain can say that.
 */
export function verify(v: Voucher): boolean {
  fixed("signature", v.signature, 64);
  fixed("devicePubkey", v.devicePubkey, 33);
  try {
    return p256.verify(v.signature, signedMessage(v), v.devicePubkey, { prehash: true });
  } catch {
    return false;
  }
}

const P256_ORDER = BigInt(
  "0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551",
);

/**
 * Android's KeyStore returns ECDSA signatures DER-encoded, with an S value that
 * may be in the upper half of the curve order. Solana's secp256r1 precompile
 * wants 64 raw bytes, r‖s, low-S. This conversion is the single most reliable
 * time-sink in week one, so it lives here with its own vectors.
 *
 *   SEQUENCE { INTEGER r, INTEGER s }
 */
export function derToRawSignature(der: Uint8Array): Uint8Array {
  let i = 0;
  const need = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`malformed DER signature: ${msg}`);
  };

  need(der[i++] === 0x30, "expected SEQUENCE");
  let seqLen = der[i++]!;
  // Long-form length: 0x81 means one following length byte.
  if (seqLen === 0x81) seqLen = der[i++]!;
  need(seqLen === der.length - i, "declared length does not match");

  const readInt = (): bigint => {
    need(der[i++] === 0x02, "expected INTEGER");
    const len = der[i++]!;
    need(len > 0 && i + len <= der.length, "bad INTEGER length");
    let value = 0n;
    for (let k = 0; k < len; k++) value = (value << 8n) | BigInt(der[i + k]!);
    i += len;
    return value;
  };

  const r = readInt();
  let s = readInt();
  need(i === der.length, "trailing bytes");

  // Low-S normalisation. Both s and order-s are valid ECDSA signatures; the
  // precompile accepts only the low one, so a high-S signature that verifies
  // fine on the phone is rejected on chain unless it is folded here.
  if (s > P256_ORDER / 2n) s = P256_ORDER - s;

  const out = new Uint8Array(64);
  const put = (value: bigint, offset: number) => {
    for (let k = 31; k >= 0; k--) {
      out[offset + k] = Number(value & 0xffn);
      value >>= 8n;
    }
  };
  put(r, 0);
  put(s, 32);
  return out;
}

export function isLowS(rawSignature: Uint8Array): boolean {
  fixed("signature", rawSignature, 64);
  let s = 0n;
  for (let k = 32; k < 64; k++) s = (s << 8n) | BigInt(rawSignature[k]!);
  return s <= P256_ORDER / 2n;
}
