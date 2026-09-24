/**
 * Reporting a double spend and taking the stake that backed it, paid for by
 * the relayer.
 *
 * Proof comes from two places:
 *
 *   - a till shown two different vouchers at one sequence (POST /v1/conflict);
 *   - the relayer itself, asked to submit a voucher at a sequence it already
 *     submitted a *different* voucher for (see `redeem.ts`).
 *
 * Either way the merchant who was cheated does nothing. The vault freezes, so
 * the payer's exit is blocked, and then its stake moves to the reserve. The
 * USDC collateral stays for honest merchants to redeem against; see `slash`.
 *
 * Only proof that holds is paid for: the pair is checked offline first
 * (`checkConflict`), a vault already frozen is not reported again, and each
 * report is remembered so a till's retry does not buy a second one.
 */
import { decodeRiskConfig, decodeVault } from "@nelo/enrol";
import { associatedTokenAddress, buildTransaction, checkConflict, reportConflictInstructions, riskConfigAddress, slashInstruction, TOKEN_PROGRAM_ID } from "@nelo/redeem";
import { encodeBase58 } from "@nelo/voucher";
import type { FeePayer } from "./feePayer.ts";
import { rollDay, utcDay, type ConflictReport, type Ledger } from "./ledger.ts";
import { SIGNATURE_FEE_LAMPORTS, type Limits } from "./policy.ts";
import type { RelayRpc } from "./redeem.ts";

export interface ConflictRpc extends RelayRpc {
  /** Raw account data, or null if there is no such account. */
  accountData(address: string): Promise<Uint8Array | null>;
}

export type ConflictResponse =
  /** Reported, now or earlier. */
  | { status: "reported"; signature: string }
  /** Someone already froze it. Nothing to pay for. */
  | { status: "already-frozen" }
  /** Simulation refused it: usually a key the vault never enrolled. */
  | { status: "rejected"; err: unknown }
  | { status: "declined"; reason: string };

export interface ConflictDeps {
  rpc: ConflictRpc;
  feePayer: FeePayer;
  ledger: Ledger;
  limits: Limits;
  programId?: string;
  /** Unix seconds. */
  now: number;
}

const VAULT_STATUS_FROZEN = 1;
const toBase64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

async function vaultFrozen(rpc: ConflictRpc, vault: string): Promise<boolean | null> {
  const data = await rpc.accountData(vault);
  return data ? decodeVault(data).status === VAULT_STATUS_FROZEN : null;
}

async function signAndSend(
  deps: ConflictDeps,
  instructions: Parameters<typeof buildTransaction>[0],
  record: (signature: string, lastValidBlockHeight: number) => void,
): Promise<{ ok: true; signature: string } | { ok: false; err: unknown }> {
  const lifetime = await deps.rpc.latestBlockhash();
  const unsigned = buildTransaction(instructions, deps.feePayer.address, {
    blockhash: lifetime.blockhash,
    lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight),
  });
  const sig = deps.feePayer.sign(unsigned.message);
  const wire = new Uint8Array(unsigned.wire);
  wire.set(sig, 1);
  const signature = encodeBase58(sig);
  record(signature, lifetime.lastValidBlockHeight); // durable before it is sent
  try {
    const sent = await deps.rpc.send(toBase64(wire));
    return sent.ok ? { ok: true, signature } : { ok: false, err: sent.err };
  } catch {
    return { ok: true, signature }; // may have gone out; the ledger has it
  }
}

export async function reportConflict(a: Uint8Array, b: Uint8Array, deps: ConflictDeps): Promise<ConflictResponse> {
  const checked = checkConflict(a, b);
  if (!checked.ok) return { status: "declined", reason: checked.reason };
  const id = `${checked.vault}:${checked.seq}`;

  let state = rollDay(deps.ledger.read(), utcDay(deps.now));
  const conflicts = { ...(state.conflicts ?? {}) };
  const existing = conflicts[id];
  if (existing?.signature) {
    const live =
      (await deps.rpc.signatureKnown(existing.signature)) ||
      (await deps.rpc.blockHeight()) <= existing.lastValidBlockHeight;
    if (live) return { status: "reported", signature: existing.signature };
  }

  const frozen = await vaultFrozen(deps.rpc, checked.vault);
  if (frozen === null) return { status: "declined", reason: "no such vault on chain" };
  if (frozen) {
    // Keep the proof anyway, so the sweep can still slash if stake remains.
    if (!existing) {
      conflicts[id] = { a: toBase64(a), b: toBase64(b), vault: checked.vault, signature: null, lastValidBlockHeight: 0, reportedAt: deps.now, slashSignature: null };
      deps.ledger.write({ ...state, conflicts });
    }
    return { status: "already-frozen" };
  }

  if (state.spentLamports + SIGNATURE_FEE_LAMPORTS > deps.limits.budgetLamports) {
    return { status: "declined", reason: "the relayer's budget for this window is spent" };
  }

  const result = await signAndSend(
    deps,
    reportConflictInstructions(a, b, deps.feePayer.address, deps.programId),
    (signature, lastValidBlockHeight) => {
      const report: ConflictReport = {
        a: toBase64(a),
        b: toBase64(b),
        vault: checked.vault,
        signature,
        lastValidBlockHeight,
        reportedAt: deps.now,
        slashSignature: existing?.slashSignature ?? null,
      };
      state = { ...state, conflicts: { ...conflicts, [id]: report }, spentLamports: state.spentLamports + SIGNATURE_FEE_LAMPORTS };
      deps.ledger.write(state);
    },
  );
  if (!result.ok) {
    // Nothing landed: keep the proof, drop the signature, give the fee back.
    const report = { ...state.conflicts![id]!, signature: null };
    deps.ledger.write({
      ...state,
      conflicts: { ...state.conflicts, [id]: report },
      spentLamports: Math.max(0, state.spentLamports - SIGNATURE_FEE_LAMPORTS),
    });
    return { status: "rejected", err: result.err };
  }
  return { status: "reported", signature: result.signature };
}

export interface SweepResult {
  slashed: { vault: string; signature: string }[];
  skipped: { vault: string; reason: string }[];
}

/**
 * For every reported vault that is now frozen and still holds stake, move the
 * stake to the reserve. Run on a timer; each slash is recorded, so a vault is
 * swept once.
 */
export async function sweep(deps: ConflictDeps): Promise<SweepResult> {
  const out: SweepResult = { slashed: [], skipped: [] };
  let state = rollDay(deps.ledger.read(), utcDay(deps.now));
  const programId = deps.programId;
  const config = riskConfigAddress(programId);
  const configData = await deps.rpc.accountData(config);
  if (!configData) return out;
  const stakeMint = decodeRiskConfig(configData).stakeMint;

  for (const [id, report] of Object.entries(state.conflicts ?? {})) {
    if (report.slashSignature) continue;
    const vaultData = await deps.rpc.accountData(report.vault);
    if (!vaultData || decodeVault(vaultData).status !== VAULT_STATUS_FROZEN) {
      out.skipped.push({ vault: report.vault, reason: "not frozen yet" });
      continue;
    }
    const stakeAccount = await deps.rpc.accountData(associatedTokenAddress(report.vault, stakeMint, TOKEN_PROGRAM_ID));
    // SPL token account: mint(32) ‖ owner(32) ‖ amount(u64 LE)
    const staked = stakeAccount ? new DataView(stakeAccount.buffer, stakeAccount.byteOffset).getBigUint64(64, true) : 0n;
    if (staked === 0n) {
      out.skipped.push({ vault: report.vault, reason: "no stake to slash" });
      state = { ...state, conflicts: { ...state.conflicts, [id]: { ...report, slashSignature: "none" } } };
      deps.ledger.write(state);
      continue;
    }
    if (state.spentLamports + SIGNATURE_FEE_LAMPORTS > deps.limits.budgetLamports) {
      out.skipped.push({ vault: report.vault, reason: "budget spent" });
      continue;
    }
    const result = await signAndSend(
      deps,
      [slashInstruction({ cranker: deps.feePayer.address, vault: report.vault, stakeMint, ...(programId ? { programId } : {}) })],
      (signature) => {
        state = {
          ...state,
          conflicts: { ...state.conflicts, [id]: { ...report, slashSignature: signature } },
          spentLamports: state.spentLamports + SIGNATURE_FEE_LAMPORTS,
        };
        deps.ledger.write(state);
      },
    );
    if (result.ok) out.slashed.push({ vault: report.vault, signature: result.signature });
    else {
      state = { ...state, conflicts: { ...state.conflicts, [id]: { ...report, slashSignature: null } } };
      deps.ledger.write(state);
      out.skipped.push({ vault: report.vault, reason: `slash refused: ${JSON.stringify(result.err)}` });
    }
  }
  return out;
}
