/**
 * Submitting a merchant's voucher, paid for by the relayer.
 *
 * This is what lets a merchant settle offline sales with no SOL and no wallet
 * prompt. `redeem_voucher`'s only signer is whoever pays; the merchant is an
 * account, and the program pays exactly the merchant the voucher names. So
 * the relayer can submit a voucher and cannot redirect it.
 *
 * ## Asked twice, it answers once
 *
 * The till records the signature this returns only after it returns. A till
 * that crashes in between asks again, and must get the same signature back
 * while that transaction can still land. Otherwise it would submit twice,
 * see "already redeemed" on the second, and report its own payment as fraud.
 * So a live submission is always answered with itself, and a new one is built
 * only once the old one provably cannot land: not found, and its blockhash
 * past its last valid height.
 *
 * ## Recorded before it is sent
 *
 * The ledger entry is written before the transaction leaves, for the same
 * reason the till's queue does it: a crash after sending, with nothing
 * written, is a transaction nobody knows about.
 */
import { decode, encodeBase58, SIGNED_LEN } from "@nelo/voucher";
import { associatedTokenAddress, buildRedemption, TOKEN_PROGRAM_ID } from "@nelo/redeem";
import { decide, type Limits } from "./policy.ts";
import type { FeePayer } from "./feePayer.ts";
import { rollDay, utcDay, type Ledger, type LedgerState, type Submission } from "./ledger.ts";

export interface RelayRpc {
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  blockHeight(): Promise<number>;
  accountExists(address: string): Promise<boolean>;
  /** Whether the chain knows this signature at all, landed or failed. */
  signatureKnown(signature: string): Promise<boolean>;
  /**
   * `sendTransaction` with preflight. `{ ok: false, err }` is the simulation's
   * transaction error; throw for anything that is not an answer.
   */
  send(wireBase64: string): Promise<{ ok: true } | { ok: false; err: unknown }>;
}

export interface RelayConfig {
  mint: string;
  tokenProgram?: string;
  programId?: string;
  limits: Limits;
}

export type RedeemResponse =
  /** Submitted, now or earlier. The till looks the signature up. */
  | { status: "sent"; signature: string }
  /** Simulation refused it: nothing landed, and `err` says why. */
  | { status: "rejected"; err: unknown }
  /**
   * The relayer will not pay for it. `retryable` if waiting could change that.
   * `conflictWith` is the *other* voucher at this sequence, base64, when this
   * one lost to a double spend: the caller reports the pair.
   */
  | { status: "declined"; reason: string; retryable: boolean; conflictWith?: string };

export interface RedeemDeps {
  rpc: RelayRpc;
  feePayer: FeePayer;
  ledger: Ledger;
  config: RelayConfig;
  /** Unix seconds. */
  now: number;
}

/** Refusals that a new day's budget can change. Everything else stands. */
const RETRYABLE = [/budget for this window is spent/, /reached its sponsorship limit/];

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const toBase64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

function forget(state: LedgerState, id: string, vault: string, merchant: string): LedgerState {
  const s = state.submissions[id];
  if (!s) return state;
  const submissions = { ...state.submissions };
  delete submissions[id];
  return {
    ...state,
    submissions,
    // It never landed, so it cost nothing: give the budget back.
    spentLamports: Math.max(0, state.spentLamports - s.costLamports),
    perVault: { ...state.perVault, [vault]: Math.max(0, (state.perVault[vault] ?? 1) - 1) },
    fundedMerchants: s.createsAccount ? state.fundedMerchants.filter((m) => m !== merchant) : state.fundedMerchants,
  };
}

export async function redeem(packet: Uint8Array, deps: RedeemDeps): Promise<RedeemResponse> {
  const { rpc, feePayer, ledger, config, now } = deps;
  const tokenProgram = config.tokenProgram ?? TOKEN_PROGRAM_ID;
  let state = rollDay(ledger.read(), utcDay(now));

  let vault: string;
  let merchant: string;
  let seq: bigint;
  try {
    const v = decode(packet);
    vault = encodeBase58(v.vault);
    merchant = encodeBase58(v.merchant);
    seq = v.seq;
  } catch (e) {
    return { status: "declined", reason: e instanceof Error ? e.message : "not a voucher", retryable: false };
  }
  const id = `${vault}:${seq}`;
  const message = hex(packet.subarray(0, SIGNED_LEN));

  // Asked before: answer with what was submitted, unless it cannot land.
  const existing = state.submissions[id];
  if (existing) {
    if (existing.message !== message) {
      return {
        status: "declined",
        reason: "a different voucher at this sequence was already submitted",
        retryable: false,
        ...(existing.packet ? { conflictWith: existing.packet } : {}),
      };
    }
    if (await rpc.signatureKnown(existing.signature)) return { status: "sent", signature: existing.signature };
    if ((await rpc.blockHeight()) <= existing.lastValidBlockHeight) {
      return { status: "sent", signature: existing.signature };
    }
    // Provably dead. Build it again below.
    state = forget(state, id, vault, merchant);
  }

  const merchantToken = associatedTokenAddress(merchant, config.mint, tokenProgram);
  const merchantTokenExists = await rpc.accountExists(merchantToken);
  if (!merchantTokenExists && state.fundedMerchants.includes(merchant)) {
    // Funded once and gone since: the merchant closed it, and paying rent for
    // it again on every voucher is exactly how a sponsor is drained.
    return { status: "declined", reason: "this merchant's token account was already funded once", retryable: false };
  }

  const decision = decide(
    { voucherBytes: packet, merchantTokenExists, mint: config.mint },
    config.limits,
    { lamports: state.spentLamports, forThisVault: state.perVault[vault] ?? 0 },
    now,
  );
  if (!decision.sponsor) {
    return { status: "declined", reason: decision.reason, retryable: RETRYABLE.some((r) => r.test(decision.reason)) };
  }

  const lifetime = await rpc.latestBlockhash();
  const unsigned = buildRedemption(
    {
      voucher: packet,
      payer: feePayer.address,
      mint: config.mint,
      tokenProgram,
      ...(config.programId ? { programId: config.programId } : {}),
    },
    { blockhash: lifetime.blockhash, lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight) },
  );
  const signatureBytes = feePayer.sign(unsigned.message);
  const wire = new Uint8Array(unsigned.wire);
  wire.set(signatureBytes, 1); // after the compact-u16 signature count: one signer
  const signature = encodeBase58(signatureBytes);

  const submission: Submission = {
    message,
    packet: toBase64(packet),
    signature,
    lastValidBlockHeight: lifetime.lastValidBlockHeight,
    costLamports: decision.costLamports,
    createsAccount: decision.createsAccount,
    submittedAt: now,
  };
  state = {
    ...state,
    submissions: { ...state.submissions, [id]: submission },
    spentLamports: state.spentLamports + decision.costLamports,
    perVault: { ...state.perVault, [vault]: (state.perVault[vault] ?? 0) + 1 },
    fundedMerchants: decision.createsAccount ? [...state.fundedMerchants, merchant] : state.fundedMerchants,
  };
  ledger.write(state); // durable before it is sent

  let sent: { ok: true } | { ok: false; err: unknown };
  try {
    sent = await rpc.send(toBase64(wire));
  } catch {
    // It may or may not have gone out. The ledger has it, so the next ask
    // looks it up rather than building another.
    return { status: "sent", signature };
  }
  if (!sent.ok) {
    ledger.write(forget(state, id, vault, merchant));
    return { status: "rejected", err: sent.err };
  }
  return { status: "sent", signature };
}
