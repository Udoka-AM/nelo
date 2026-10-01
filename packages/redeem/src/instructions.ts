/**
 * The redemption transaction: what a merchant broadcasts when the phone finds
 * the network again, to turn a voucher into USDC in their account.
 *
 * Two instructions, in this order and nowhere else:
 *
 *   0  secp256r1 precompile — verifies the device's P-256 signature
 *   1  nelo_vault::redeem_voucher — checks instruction 0 verified *this*
 *      voucher under *this* vault's enrolled key, then pays
 *
 * The program reads the precompile at a fixed index, 0. So nothing may come
 * before it — including the ComputeBudget instructions some wallets prepend to
 * set a priority fee. Compute-budget instructions are honoured wherever they
 * sit in a transaction, so if one is needed, append it after these two.
 *
 * Every byte this module produces is pinned to the program by
 * `vectors/redeem-v1.json`, which `programs/nelo_vault/tests/tx_vectors.rs`
 * generates from Anchor's own instruction and account builders. There is no
 * second reading of the program here to drift.
 *
 * The instruction objects are the shape `@solana/kit` takes — `programAddress`,
 * `accounts` of `{ address, role }`, `data` — with the same role numbers, so
 * they go straight into a kit transaction message. They are typed as plain
 * strings rather than kit's branded `Address`, so this package does not depend
 * on kit at runtime.
 */
import { sha256 } from "@noble/hashes/sha2";
import {
  decode,
  encodeBase58,
  signedMessage,
  SIGNED_LEN,
  type Voucher,
} from "@nelo/voucher";
import {
  addressBytes,
  associatedTokenAddress,
  concat,
  findProgramAddress,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "./address.ts";

export {
  associatedTokenAddress,
  findProgramAddress,
  isOnCurve,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./address.ts";

/** `declare_id!` in programs/nelo_vault/src/lib.rs. */
export const NELO_VAULT_PROGRAM_ID = "29QdPRQC8C5v6C8gMcBqtw9T4RxYyZ1wqThkEj3XJeQx";
export const SECP256R1_PROGRAM_ID = "Secp256r1SigVerify1111111111111111111111111";
export const INSTRUCTIONS_SYSVAR_ID = "Sysvar1nstructions1111111111111111111111111";
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

/** Kit's `AccountRole`, same numbers: bit 0 is writable, bit 1 is signer. */
export const AccountRole = {
  READONLY: 0,
  WRITABLE: 1,
  READONLY_SIGNER: 2,
  WRITABLE_SIGNER: 3,
} as const;
export type AccountRole = (typeof AccountRole)[keyof typeof AccountRole];

export interface AccountMeta {
  readonly address: string;
  readonly role: AccountRole;
}

export interface Instruction {
  readonly programAddress: string;
  readonly accounts: readonly AccountMeta[];
  readonly data: Uint8Array;
}

const COMPRESSED_PUBKEY_LEN = 33;
const SIGNATURE_LEN = 64;
/** count(1) ‖ padding(1) ‖ seven u16 offsets. */
const PRECOMPILE_HEADER_LEN = 16;
/** The precompile's "this instruction" sentinel. */
const SELF = 0xffff;

const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

/**
 * Secp256r1 precompile instruction data, verifying one signature. The layout
 * is `precompile_instruction_data` in programs/nelo_vault/src/voucher.rs; see
 * the diagram there.
 */
export function precompileInstructionData(
  message: Uint8Array,
  signature: Uint8Array,
  devicePubkey: Uint8Array,
): Uint8Array {
  if (signature.length !== SIGNATURE_LEN) {
    throw new Error(`signature must be ${SIGNATURE_LEN} bytes, got ${signature.length}`);
  }
  if (devicePubkey.length !== COMPRESSED_PUBKEY_LEN) {
    throw new Error(`device key must be ${COMPRESSED_PUBKEY_LEN} bytes, got ${devicePubkey.length}`);
  }
  // The precompile takes compressed SEC1 only. An uncompressed key's first 33
  // bytes would fail there with an error that says nothing useful.
  if (devicePubkey[0] !== 0x02 && devicePubkey[0] !== 0x03) {
    throw new Error("device key must be a compressed SEC1 point (0x02 or 0x03 prefix)");
  }
  if (message.length > 0xffff) throw new Error("message length must fit in a u16");

  const pubkeyOffset = PRECOMPILE_HEADER_LEN;
  const signatureOffset = pubkeyOffset + COMPRESSED_PUBKEY_LEN;
  const messageOffset = signatureOffset + SIGNATURE_LEN;

  const out = new Uint8Array(messageOffset + message.length);
  const dv = new DataView(out.buffer);
  out[0] = 1; // exactly one signature
  out[1] = 0; // padding
  const offsets = [
    signatureOffset,
    SELF,
    pubkeyOffset,
    SELF,
    messageOffset,
    message.length,
    SELF,
  ];
  offsets.forEach((value, i) => dv.setUint16(2 + i * 2, value, true));
  out.set(devicePubkey, pubkeyOffset);
  out.set(signature, signatureOffset);
  out.set(message, messageOffset);
  return out;
}

/** Anchor's discriminator: the first 8 bytes of sha256("global:redeem_voucher"). */
export const REDEEM_VOUCHER_DISCRIMINATOR: Uint8Array = sha256(
  new TextEncoder().encode("global:redeem_voucher"),
).slice(0, 8);

/**
 * `redeem_voucher` instruction data. `VoucherArgs` Borsh-serialises to exactly
 * the 105 bytes the device signed — the Rust side pins that — so the argument
 * is the signed message itself, not a re-encoding of it.
 */
export function redeemInstructionData(message: Uint8Array): Uint8Array {
  if (message.length !== SIGNED_LEN) {
    throw new Error(`signed message must be ${SIGNED_LEN} bytes, got ${message.length}`);
  }
  return concat(REDEEM_VOUCHER_DISCRIMINATOR, message);
}

/**
 * Fold a P-256 signature to low-S.
 *
 * Both (r, s) and (r, n − s) are valid signatures over the same message; the
 * precompile accepts only the low one. `derToRawSignature` folds on the payer's
 * phone, but a voucher that arrives high-S anyway still verifies offline, so a
 * merchant takes it — and it would then fail to settle for a reason that has
 * nothing to do with the payment. Folding needs no key, so do it here too.
 */
export function lowS(signature: Uint8Array): Uint8Array {
  if (signature.length !== SIGNATURE_LEN) {
    throw new Error(`signature must be ${SIGNATURE_LEN} bytes, got ${signature.length}`);
  }
  let s = 0n;
  for (let k = 32; k < 64; k++) s = (s << 8n) | BigInt(signature[k]!);
  if (s <= P256_ORDER / 2n) return signature.slice();
  s = P256_ORDER - s;
  const out = signature.slice();
  for (let k = 63; k >= 32; k--) {
    out[k] = Number(s & 0xffn);
    s >>= 8n;
  }
  return out;
}

export function riskConfigAddress(programId: string = NELO_VAULT_PROGRAM_ID): string {
  return findProgramAddress([new TextEncoder().encode("risk")], programId)[0];
}

export interface RedeemInput {
  /** The 202-byte packet as received, or one already decoded. */
  voucher: Uint8Array | Voucher;
  /** Who signs and pays the fee — the merchant, or a relayer. */
  payer: string;
  /** The vault's mint. The voucher does not carry it; the enrolment does. */
  mint: string;
  /**
   * The mint's token program. Required rather than defaulted: it is a seed of
   * both token accounts, and guessing it wrong produces addresses that exist
   * nowhere, which the program reports as a constraint failure on the vault.
   */
  tokenProgram: string;
  /** Defaults to the deployed program. Overridable for a local deployment. */
  programId?: string;
}

/**
 * Both instructions of a redemption, in order. Put them first in the
 * transaction and keep them adjacent — see the note at the top of this file.
 */
export function redeemInstructions(input: RedeemInput): readonly [Instruction, Instruction] {
  const voucher = input.voucher instanceof Uint8Array ? decode(input.voucher) : input.voucher;
  const programId = input.programId ?? NELO_VAULT_PROGRAM_ID;
  if (input.tokenProgram !== TOKEN_PROGRAM_ID && input.tokenProgram !== TOKEN_2022_PROGRAM_ID) {
    // The program takes `Interface<TokenInterface>`: these two and no others.
    throw new Error(`not a token program: ${input.tokenProgram}`);
  }
  // Throws on anything that is not 32 bytes, before it becomes a transaction.
  addressBytes(input.payer);
  addressBytes(input.mint);
  addressBytes(programId);

  const message = signedMessage(voucher);
  const vault = encodeBase58(voucher.vault);
  const merchant = encodeBase58(voucher.merchant);

  const precompile: Instruction = {
    programAddress: SECP256R1_PROGRAM_ID,
    accounts: [],
    data: precompileInstructionData(message, lowS(voucher.signature), voucher.devicePubkey),
  };

  // The order of `#[derive(Accounts)] RedeemVoucher`. Anchor matches by
  // position, not by name.
  const redeem: Instruction = {
    programAddress: programId,
    accounts: [
      { address: input.payer, role: AccountRole.WRITABLE_SIGNER },
      { address: vault, role: AccountRole.WRITABLE },
      { address: riskConfigAddress(programId), role: AccountRole.READONLY },
      { address: input.mint, role: AccountRole.READONLY },
      { address: merchant, role: AccountRole.READONLY },
      {
        address: associatedTokenAddress(merchant, input.mint, input.tokenProgram),
        role: AccountRole.WRITABLE,
      },
      {
        address: associatedTokenAddress(vault, input.mint, input.tokenProgram),
        role: AccountRole.WRITABLE,
      },
      { address: INSTRUCTIONS_SYSVAR_ID, role: AccountRole.READONLY },
      { address: input.tokenProgram, role: AccountRole.READONLY },
      { address: ASSOCIATED_TOKEN_PROGRAM_ID, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
    ],
    data: redeemInstructionData(message),
  };

  return [precompile, redeem];
}
