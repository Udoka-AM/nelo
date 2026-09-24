/**
 * Reporting a double spend, and taking the stake that backed it.
 *
 * Two different vouchers at one sequence, both signed by the vault's enrolled
 * key, are proof that the payer's device signed twice for one slot. Anyone
 * holding the pair can freeze the vault with `report_conflict`, and anyone can
 * then `slash` its stake into the reserve. Both are permissionless, so Nelo's
 * relayer can do both for the merchant who was cheated, who never sees any of
 * it.
 *
 * The transaction is the precompile verifying A at index 0, the precompile
 * verifying B at index 1, then `report_conflict`: the program reads the two
 * precompiles at exactly those indices. Pinned by the `conflict` section of
 * `vectors/redeem-v1.json`, from Anchor's own builders.
 */
import { sha256 } from "@noble/hashes/sha2";
import { decode, encodeBase58, signedMessage, SIGNED_LEN, verify } from "@nelo/voucher";
import { addressBytes, associatedTokenAddress, concat } from "./address.ts";
import {
  AccountRole,
  INSTRUCTIONS_SYSVAR_ID,
  lowS,
  NELO_VAULT_PROGRAM_ID,
  precompileInstructionData,
  riskConfigAddress,
  SECP256R1_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  type Instruction,
} from "./index.ts";

const discriminator = (name: string) => sha256(new TextEncoder().encode(`global:${name}`)).slice(0, 8);

export type ConflictCheck = { ok: true; vault: string; seq: bigint } | { ok: false; reason: string };

/**
 * Is this pair a conflict the program will accept? Checked here, for free,
 * so a relayer spends a fee only on proof that holds: same vault, same
 * sequence, different signed bytes, one device key, and both signatures good.
 * Whether that key is the one the vault enrolled is the chain's to check.
 */
export function checkConflict(a: Uint8Array, b: Uint8Array): ConflictCheck {
  let va, vb;
  try {
    va = decode(a);
    vb = decode(b);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "not a voucher" };
  }
  const vault = encodeBase58(va.vault);
  if (vault !== encodeBase58(vb.vault)) return { ok: false, reason: "the two vouchers name different vaults" };
  if (va.seq !== vb.seq) return { ok: false, reason: "the two vouchers are at different sequences" };
  const ma = signedMessage(va);
  const mb = signedMessage(vb);
  if (ma.every((x, i) => x === mb[i])) return { ok: false, reason: "the two vouchers are the same payment" };
  if (!va.devicePubkey.every((x, i) => x === vb.devicePubkey[i])) {
    return { ok: false, reason: "the two vouchers were signed by different keys" };
  }
  if (!verify(va) || !verify(vb)) return { ok: false, reason: "a signature does not verify" };
  return { ok: true, vault, seq: va.seq };
}

/** The three instructions of a conflict report, in the order the program reads them. */
export function reportConflictInstructions(
  a: Uint8Array,
  b: Uint8Array,
  reporter: string,
  programId: string = NELO_VAULT_PROGRAM_ID,
): readonly [Instruction, Instruction, Instruction] {
  const checked = checkConflict(a, b);
  if (!checked.ok) throw new Error(checked.reason);
  addressBytes(reporter);
  const va = decode(a);
  const vb = decode(b);
  const precompile = (v: typeof va): Instruction => ({
    programAddress: SECP256R1_PROGRAM_ID,
    accounts: [],
    data: precompileInstructionData(signedMessage(v), lowS(v.signature), v.devicePubkey),
  });
  return [
    precompile(va),
    precompile(vb),
    {
      programAddress: programId,
      accounts: [
        { address: reporter, role: AccountRole.WRITABLE_SIGNER },
        { address: checked.vault, role: AccountRole.WRITABLE },
        { address: INSTRUCTIONS_SYSVAR_ID, role: AccountRole.READONLY },
      ],
      data: concat(discriminator("report_conflict"), a.subarray(0, SIGNED_LEN), b.subarray(0, SIGNED_LEN)),
    },
  ];
}

/** Move a frozen vault's stake into the reserve. Needs no one's permission. */
export function slashInstruction(input: {
  cranker: string;
  vault: string;
  stakeMint: string;
  tokenProgram?: string;
  programId?: string;
}): Instruction {
  const programId = input.programId ?? NELO_VAULT_PROGRAM_ID;
  const tokenProgram = input.tokenProgram ?? TOKEN_PROGRAM_ID;
  const config = riskConfigAddress(programId);
  return {
    programAddress: programId,
    accounts: [
      { address: input.cranker, role: AccountRole.WRITABLE_SIGNER },
      { address: input.vault, role: AccountRole.READONLY },
      { address: config, role: AccountRole.READONLY },
      { address: input.stakeMint, role: AccountRole.READONLY },
      { address: associatedTokenAddress(input.vault, input.stakeMint, tokenProgram), role: AccountRole.WRITABLE },
      { address: associatedTokenAddress(config, input.stakeMint, tokenProgram), role: AccountRole.WRITABLE },
      { address: tokenProgram, role: AccountRole.READONLY },
      { address: ASSOCIATED_TOKEN_PROGRAM_ID, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
    ],
    data: discriminator("slash"),
  };
}
