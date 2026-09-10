/**
 * @nelo/attest — Android StrongBox, wrapped.
 *
 * The secure element signs; the chain verifies. There is no trusted server in
 * the value path, which is the whole argument, and it only holds if the key is
 * genuinely hardware-backed. So this module never falls back to a software key:
 * a device without StrongBox fails loudly and the app degrades to online-only.
 *
 * Android-only by construction. On any other platform the native module is
 * absent and `isAvailable()` returns false.
 */
import { requireOptionalNativeModule } from "expo";
import { compressPublicKey, derToRawSignature } from "@nelo/voucher";

interface NativeAttest {
  isStrongBoxAvailable(): boolean;
  generateAttestedKey(
    alias: string,
    challenge: Uint8Array,
  ): Promise<{ publicKey: Uint8Array; certChain: string[]; strongBoxBacked: boolean }>;
  signDer(alias: string, message: Uint8Array): Promise<Uint8Array>;
  hasKey(alias: string): boolean;
  deleteKey(alias: string): Promise<void>;
}

const Native = requireOptionalNativeModule<NativeAttest>("NeloAttest");

export interface AttestedKey {
  /** SEC1 compressed, 33 bytes — the form the vault stores as `device_pubkey`. */
  publicKey: Uint8Array;
  /** Attestation chain, leaf first, base64 DER. Verified server-side at enrolment. */
  certChain: string[];
  strongBoxBacked: boolean;
}

function native(): NativeAttest {
  if (!Native) {
    throw new Error(
      "@nelo/attest native module is not loaded. It needs a development build — " +
        "Expo Go cannot load native modules. See docs/DELIVERABLES.md.",
    );
  }
  return Native;
}

/** Whether the native module is present at all (i.e. this is a dev build on Android). */
export function isAvailable(): boolean {
  return Native !== null;
}

/**
 * Whether this handset has a discrete secure element. False on a lot of budget
 * hardware, which is the hardware this product targets — so treat false as an
 * ordinary case, not an error, and degrade to online-only.
 */
export function isStrongBoxAvailable(): boolean {
  return Native ? Native.isStrongBoxAvailable() : false;
}

/**
 * Enrol a device key. `challenge` should be a server-issued nonce; it is baked
 * into the attestation certificate and is what makes a replayed chain useless.
 */
export async function generateAttestedKey(
  alias: string,
  challenge: Uint8Array,
): Promise<AttestedKey> {
  const result = await native().generateAttestedKey(alias, challenge);
  return {
    publicKey: compressPublicKey(result.publicKey),
    certChain: result.certChain,
    strongBoxBacked: result.strongBoxBacked,
  };
}

/**
 * Sign a voucher's 105 signed bytes, returning the 64-byte raw r‖s the
 * secp256r1 precompile expects.
 *
 * Android returns DER with an S that may sit in the upper half of the curve
 * order. A high-S signature verifies perfectly well on the phone and is
 * rejected on chain — so the normalisation here is not cosmetic, and it is
 * covered by tests in @nelo/voucher that run without a handset.
 */
export async function sign(alias: string, message: Uint8Array): Promise<Uint8Array> {
  return derToRawSignature(await native().signDer(alias, message));
}

export function hasKey(alias: string): boolean {
  return Native ? Native.hasKey(alias) : false;
}

export async function deleteKey(alias: string): Promise<void> {
  await native().deleteKey(alias);
}
