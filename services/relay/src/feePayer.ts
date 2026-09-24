/**
 * The relayer's fee-payer key: a Solana CLI keypair file, the 64-byte JSON
 * array `solana-keygen new` writes (secret ‖ public).
 *
 * It pays fees and new merchants' token-account rent, and nothing else. It is
 * never an authority over anything in the program. Losing it loses the SOL in
 * it; leaking it lets someone spend that SOL. So it holds a small float, topped
 * up, rather than a treasury.
 */
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519";
import { encodeBase58 } from "@nelo/voucher";

export interface FeePayer {
  address: string;
  sign(message: Uint8Array): Uint8Array;
}

export function feePayerFromSecret(keypair: Uint8Array): FeePayer {
  if (keypair.length !== 64) throw new Error(`a Solana keypair is 64 bytes, got ${keypair.length}`);
  const secret = keypair.slice(0, 32);
  const expected = keypair.slice(32);
  const derived = ed25519.getPublicKey(secret);
  if (!derived.every((b, i) => b === expected[i])) {
    throw new Error("the keypair's public half does not match its secret");
  }
  return {
    address: encodeBase58(derived),
    sign: (message) => ed25519.sign(message, secret),
  };
}

export function loadFeePayer(path: string): FeePayer {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${path} is not a Solana keypair file`);
  return feePayerFromSecret(Uint8Array.from(parsed as number[]));
}
