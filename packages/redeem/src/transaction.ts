/**
 * The redemption as a transaction a wallet can sign, and a check that the
 * wallet signed exactly that.
 *
 * The merchant's own wallet signs over Mobile Wallet Adapter, which takes and
 * returns raw transaction bytes. Wallets are allowed to modify a transaction
 * before signing it, and some do: they prepend a ComputeBudget instruction to
 * set a priority fee. For a redemption that is fatal. The program reads the
 * signature check at instruction 0, and anything placed before it moves it to
 * 1. So {@link checkSigned} compares the signed message with the one built
 * here, byte for byte, and refuses anything that differs, before a fee is spent
 * on a transaction that cannot succeed.
 *
 * Legacy message format, not v0: every Mobile Wallet Adapter wallet signs
 * legacy transactions, and this one needs no lookup tables.
 */
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
} from "@solana/kit";
import { ed25519 } from "@noble/curves/ed25519";
import { decodeBase58, encodeBase58 } from "@nelo/voucher";
import { redeemInstructions, type Instruction, type RedeemInput } from "./index.ts";

/** Solana's packet limit for a whole transaction. */
export const PACKET_LIMIT = 1232;

export interface Unsigned {
  /** The whole transaction, with an empty signature slot for the fee payer. */
  wire: Uint8Array;
  /** The bytes the fee payer signs. */
  message: Uint8Array;
  feePayer: string;
}

export interface Lifetime {
  blockhash: string;
  lastValidBlockHeight: bigint;
}

/** The payer in `input` pays the fee and is the only signer. */
export function buildRedemption(input: RedeemInput, lifetime: Lifetime): Unsigned {
  return buildTransaction(redeemInstructions(input), input.payer, lifetime);
}

/**
 * Any instructions as a legacy transaction with one signer, the fee payer. The
 * payer app uses it for enrolment and deposit; the checks in
 * {@link checkSigned} apply the same way.
 */
export function buildTransaction(
  instructions: readonly Instruction[],
  feePayer: string,
  lifetime: Lifetime,
): Unsigned {
  const message = pipe(
    createTransactionMessage({ version: "legacy" }),
    (m) => setTransactionMessageFeePayer(address(feePayer), m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: lifetime.blockhash as Blockhash, lastValidBlockHeight: lifetime.lastValidBlockHeight },
        m,
      ),
    // Structurally kit's instruction shape; only the address brand differs.
    (m) => appendTransactionMessageInstructions(instructions as never, m),
  );
  const compiled = compileTransaction(message);
  const wire = new Uint8Array(getTransactionEncoder().encode(compiled));
  if (wire.length > PACKET_LIMIT) throw new Error(`transaction is ${wire.length} bytes, over the packet limit`);
  return { wire, message: new Uint8Array(compiled.messageBytes), feePayer };
}

export type Checked =
  | { ok: true; signature: string; wire: Uint8Array }
  | { ok: false; reason: string };

/**
 * Accept the wallet's signed bytes only if they are the transaction that was
 * built, carrying a valid signature from the fee payer. The returned
 * `signature` is the transaction's id, known before it is sent.
 */
export function checkSigned(unsigned: Unsigned, signedWire: Uint8Array): Checked {
  let decoded: ReturnType<ReturnType<typeof getTransactionDecoder>["decode"]>;
  try {
    decoded = getTransactionDecoder().decode(signedWire);
  } catch {
    return { ok: false, reason: "The wallet returned something that is not a transaction." };
  }
  const message = new Uint8Array(decoded.messageBytes);
  if (!sameBytes(message, unsigned.message)) {
    return {
      ok: false,
      reason:
        "The wallet changed the transaction before signing it, usually by adding a priority fee. " +
        "A redemption must be signed exactly as built.",
    };
  }
  const signature = (decoded.signatures as Record<string, Uint8Array | null>)[unsigned.feePayer];
  if (!signature || signature.every((b) => b === 0)) {
    return { ok: false, reason: "The wallet did not sign." };
  }
  if (!ed25519.verify(signature, message, decodeBase58(unsigned.feePayer))) {
    return { ok: false, reason: "The wallet's signature does not verify." };
  }
  return { ok: true, signature: encodeBase58(signature), wire: new Uint8Array(signedWire) };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
