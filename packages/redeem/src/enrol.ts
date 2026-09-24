/**
 * The payer's setup: open a vault enrolling this phone's secure-element key,
 * then lock collateral in it. Both are signed by the payer's own wallet.
 *
 * Pinned to Anchor's own builders by the `enrolment` section of
 * `vectors/redeem-v1.json`, like the redemption.
 */
import { sha256 } from "@noble/hashes/sha2";
import { addressBytes, associatedTokenAddress, concat, findProgramAddress } from "./address.ts";
import {
  AccountRole,
  NELO_VAULT_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  type Instruction,
} from "./index.ts";
import { ASSOCIATED_TOKEN_PROGRAM_ID } from "./address.ts";

function discriminator(name: string): Uint8Array {
  return sha256(new TextEncoder().encode(`global:${name}`)).slice(0, 8);
}

function u64(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 64n) throw new Error(`${value} does not fit a u64`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

/** The vault PDA: `[b"vault", owner]`. One vault per owner wallet. */
export function vaultAddress(owner: string, programId: string = NELO_VAULT_PROGRAM_ID): string {
  return findProgramAddress([new TextEncoder().encode("vault"), addressBytes(owner)], programId)[0];
}

export interface InitializeVaultInput {
  owner: string;
  mint: string;
  tokenProgram: string;
  /** SEC1 compressed P-256 key from the phone's secure element. */
  devicePubkey: Uint8Array;
  /** 32 bytes identifying the attestation chain, e.g. its SHA-256. */
  attestationId: Uint8Array;
  floorLimit: bigint;
  programId?: string;
}

export function initializeVaultInstruction(input: InitializeVaultInput): Instruction {
  if (input.devicePubkey.length !== 33 || (input.devicePubkey[0] !== 2 && input.devicePubkey[0] !== 3)) {
    throw new Error("device key must be a 33-byte compressed SEC1 point");
  }
  if (input.attestationId.length !== 32) throw new Error("attestation id must be 32 bytes");
  const programId = input.programId ?? NELO_VAULT_PROGRAM_ID;
  const vault = vaultAddress(input.owner, programId);
  return {
    programAddress: programId,
    accounts: [
      { address: input.owner, role: AccountRole.WRITABLE_SIGNER },
      { address: vault, role: AccountRole.WRITABLE },
      { address: input.mint, role: AccountRole.READONLY },
      { address: associatedTokenAddress(vault, input.mint, input.tokenProgram), role: AccountRole.WRITABLE },
      { address: input.tokenProgram, role: AccountRole.READONLY },
      { address: ASSOCIATED_TOKEN_PROGRAM_ID, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
    ],
    data: concat(discriminator("initialize_vault"), input.devicePubkey, input.attestationId, u64(input.floorLimit)),
  };
}

export interface DepositInput {
  owner: string;
  mint: string;
  tokenProgram: string;
  amount: bigint;
  programId?: string;
}

/** Locks `amount` from the owner's associated token account into the vault. */
export function depositInstruction(input: DepositInput): Instruction {
  if (input.amount <= 0n) throw new Error("deposit must be more than zero");
  const programId = input.programId ?? NELO_VAULT_PROGRAM_ID;
  const vault = vaultAddress(input.owner, programId);
  return {
    programAddress: programId,
    accounts: [
      { address: input.owner, role: AccountRole.WRITABLE_SIGNER },
      { address: vault, role: AccountRole.WRITABLE },
      { address: input.mint, role: AccountRole.READONLY },
      { address: associatedTokenAddress(input.owner, input.mint, input.tokenProgram), role: AccountRole.WRITABLE },
      { address: associatedTokenAddress(vault, input.mint, input.tokenProgram), role: AccountRole.WRITABLE },
      { address: input.tokenProgram, role: AccountRole.READONLY },
    ],
    data: concat(discriminator("deposit"), u64(input.amount)),
  };
}
