/**
 * Program-derived and associated-token addresses, synchronously, with nothing
 * but SHA-256.
 *
 * `@solana/addresses` does this already, but through `crypto.subtle`, which
 * Hermes does not have and neither app polyfills. The merchant app has to
 * derive these on the phone, in a dead zone, so it gets a version that runs
 * there. The test suite checks this one against `@solana/addresses` on Node,
 * and against the program's own derivations through the golden vectors.
 */
import { sha256 } from "@noble/hashes/sha2";
import { decodeBase58, encodeBase58 } from "@nelo/voucher";

const P = 2n ** 255n - 19n;
/** The Edwards d constant, −121665/121666 mod p. */
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;

function pow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  base %= P;
  while (exponent > 0n) {
    if (exponent & 1n) result = (result * base) % P;
    base = (base * base) % P;
    exponent >>= 1n;
  }
  return result;
}

/**
 * Whether 32 bytes decompress to a point on ed25519 — the check a PDA must
 * fail, and the one that decides which bump is canonical.
 *
 * This matches curve25519-dalek's `CompressedEdwardsY::decompress`, which is
 * what the runtime runs, rather than the stricter RFC 8032 decoding: the sign
 * bit is ignored, y is not required to be canonical, and the point is on the
 * curve exactly when x² = (y² − 1)/(d·y² + 1) has a root. The strict decoders
 * differ from dalek on a handful of encodings, and a single disagreement is a
 * PDA the program will not recognise.
 */
export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) throw new Error(`a point is 32 bytes, got ${bytes.length}`);
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i]! & 0x7f : bytes[i]!);
  y %= P;
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P; // never zero: d is not a square
  const x2 = (u * pow(v, P - 2n)) % P;
  return x2 === 0n || pow(x2, (P - 1n) / 2n) === 1n;
}

const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");
const MAX_SEEDS = 16;
const MAX_SEED_LEN = 32;

export function addressBytes(address: string): Uint8Array {
  const bytes = decodeBase58(address);
  if (bytes.length !== 32) {
    throw new Error(`not a Solana address (${bytes.length} bytes): ${address}`);
  }
  return bytes;
}

/** `Pubkey::find_program_address`: the highest bump whose hash is off the curve. */
export function findProgramAddress(
  seeds: readonly Uint8Array[],
  programId: string,
): [address: string, bump: number] {
  // The bump is a seed too, so the caller gets one fewer than the runtime's 16.
  if (seeds.length > MAX_SEEDS - 1) throw new Error(`at most ${MAX_SEEDS - 1} seeds`);
  for (const seed of seeds) {
    if (seed.length > MAX_SEED_LEN) throw new Error(`a seed is at most ${MAX_SEED_LEN} bytes`);
  }
  const program = addressBytes(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const hash = sha256
      .create()
      .update(concat(...seeds, Uint8Array.of(bump), program, PDA_MARKER))
      .digest();
    if (!isOnCurve(hash)) return [encodeBase58(hash), bump];
  }
  throw new Error("no viable bump seed");
}

export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/**
 * The associated token account for `owner`. The token program is a seed, so a
 * Token-2022 mint's accounts live at different addresses from an SPL Token
 * mint's — which is why it is a required argument rather than a default.
 */
export function associatedTokenAddress(owner: string, mint: string, tokenProgram: string): string {
  return findProgramAddress(
    [addressBytes(owner), addressBytes(tokenProgram), addressBytes(mint)],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
