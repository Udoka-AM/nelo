/**
 * Paying the fee on a merchant's cash-out.
 *
 * A cash-out is the merchant's USDC sent to the payout partner's deposit
 * address for one order. The merchant signs it; the relayer pays the fee, so
 * cashing out needs no SOL either.
 *
 * ## The relayer signs only what it built
 *
 * `prepare` builds the transfer, signs it as fee payer, and remembers its
 * exact bytes. `submit` takes the merchant's signed copy, refuses it unless
 * the message is exactly the one built and the merchant's signature verifies,
 * and sends it. So the relayer never parses a stranger's transaction to decide
 * whether paying for it is safe.
 *
 * It signs first, before the wallet sees the transfer, because wallets on
 * mainnet add a priority-fee instruction to a transaction nobody else has
 * signed yet, and an added instruction is a different message: the relayer
 * would rightly refuse it. A transaction already carrying another signature
 * is left alone. The transfer also sets its own priority fee, so there is
 * nothing for the wallet to add. Signing first means the merchant could send
 * it themselves, so its cost is counted when it is signed, not when it is sent.
 *
 * ## What bounds the cost
 *
 * The relayer cannot tell a real partner deposit address from any other: the
 * merchant is only moving their own tokens, and could send them anywhere with
 * a wallet of their own. What the relayer spends is a fee per transfer, and
 * rent when the deposit address has no token account yet. So: the vault's mint
 * only, a cap per merchant per day, the daily budget, and opening deposit
 * accounts only when configured to.
 *
 * ## Asked twice, it answers once
 *
 * One transfer per order id. Preparing again returns the same transaction
 * while it can still land; submitting again returns the same signature.
 */
import {
  associatedTokenAddress,
  buildCashout,
  checkOwnerSigned,
  TOKEN_PROGRAM_ID,
  withSignature,
  type Unsigned,
} from "@nelo/redeem";
import { encodeBase58 } from "@nelo/voucher";
import type { FeePayer } from "./feePayer.ts";
import { rollDay, utcDay, type Ledger, type LedgerState, type Transfer } from "./ledger.ts";
import { ATA_RENT_LAMPORTS, SIGNATURE_FEE_LAMPORTS } from "./policy.ts";
import type { RelayRpc } from "./redeem.ts";

export interface CashoutLimits {
  /** Cash-out transfers per merchant per UTC day. */
  perOwnerPerDay: number;
  /** Pay rent to open a deposit address's token account when it has none. */
  sponsorDepositAccounts: boolean;
  /** Shared with redemptions. */
  budgetLamports: number;
  /** Priority fee per compute unit, in micro-lamports. 0: none set. */
  priorityMicroLamports?: bigint;
}

/** Enough for create_idempotent and transfer_checked, with room. */
const computeUnitsFor = (createsAccount: boolean) => (createsAccount ? 60_000 : 20_000);

export interface CashoutDeps {
  rpc: RelayRpc;
  feePayer: FeePayer;
  ledger: Ledger;
  mint: string;
  decimals: number;
  tokenProgram?: string;
  limits: CashoutLimits;
  /** Unix seconds. */
  now: number;
}

export type Prepared =
  | { status: "prepared"; wire: string; lastValidBlockHeight: number; createsAccount: boolean }
  | { status: "sent"; signature: string }
  | { status: "declined"; reason: string; retryable: boolean };

export type Submitted =
  | { status: "sent"; signature: string }
  | { status: "rejected"; err: unknown }
  | { status: "declined"; reason: string; retryable: boolean };

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (s: string) => Uint8Array.from({ length: s.length / 2 }, (_, i) => parseInt(s.slice(i * 2, i * 2 + 2), 16));
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

function unsignedOf(t: Transfer, feePayer: string): Unsigned {
  return { wire: new Uint8Array(Buffer.from(t.wire, "base64")), message: fromHex(t.message), feePayer };
}

export async function prepareCashout(
  input: { order: string; owner: string; deposit: string; amount: bigint },
  deps: CashoutDeps,
): Promise<Prepared> {
  const { rpc, feePayer, ledger, limits } = deps;
  const tokenProgram = deps.tokenProgram ?? TOKEN_PROGRAM_ID;
  let state = rollDay(ledger.read(), utcDay(deps.now));

  if (!/^[\w-]{1,128}$/.test(input.order)) return { status: "declined", reason: "not an order id", retryable: false };
  if (input.amount <= 0n) return { status: "declined", reason: "nothing to cash out", retryable: false };
  if (input.owner === feePayer.address) return { status: "declined", reason: "not a merchant", retryable: false };

  const existing = state.transfers?.[input.order];
  if (existing) {
    if (existing.owner !== input.owner || existing.deposit !== input.deposit || existing.amount !== input.amount.toString()) {
      return { status: "declined", reason: "this order already has a different cash-out", retryable: false };
    }
    if (existing.signature) return { status: "sent", signature: existing.signature };
    if ((await rpc.blockHeight()) <= existing.lastValidBlockHeight) {
      return {
        status: "prepared",
        wire: existing.wire,
        lastValidBlockHeight: existing.lastValidBlockHeight,
        createsAccount: existing.createsAccount,
      };
    }
    // Never signed by the relayer, and now too old to land: build it again.
  }

  const sentToday = state.perOwner?.[input.owner] ?? 0;
  if (sentToday >= limits.perOwnerPerDay) {
    return { status: "declined", reason: "this merchant has reached today's cash-out limit", retryable: true };
  }

  let createsAccount = false;
  try {
    const depositToken = associatedTokenAddress(input.deposit, deps.mint, tokenProgram);
    createsAccount = !(await rpc.accountExists(depositToken));
  } catch (e) {
    if (e instanceof Error && /address|base58|bytes/i.test(e.message)) {
      return { status: "declined", reason: "not a deposit address", retryable: false };
    }
    throw e;
  }
  if (createsAccount && !limits.sponsorDepositAccounts) {
    return { status: "declined", reason: "the deposit address has no token account, and opening one is not sponsored", retryable: false };
  }
  const price = limits.priorityMicroLamports ?? 0n;
  const priorityLamports = Number((BigInt(computeUnitsFor(createsAccount)) * price + 999_999n) / 1_000_000n);
  const costLamports = SIGNATURE_FEE_LAMPORTS * 2 + priorityLamports + (createsAccount ? ATA_RENT_LAMPORTS : 0);
  if (state.spentLamports + costLamports > limits.budgetLamports) {
    return { status: "declined", reason: "the relayer's budget for this window is spent", retryable: true };
  }

  const lifetime = await rpc.latestBlockhash();
  let unsigned: Unsigned;
  try {
    unsigned = buildCashout(
      {
        owner: input.owner,
        deposit: input.deposit,
        mint: deps.mint,
        amount: input.amount,
        decimals: deps.decimals,
        feePayer: feePayer.address,
        createDepositAccount: createsAccount,
        tokenProgram,
        ...(price > 0n ? { priority: { computeUnits: computeUnitsFor(createsAccount), microLamportsPerUnit: price } } : {}),
      },
      { blockhash: lifetime.blockhash, lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight) },
    );
  } catch (e) {
    return { status: "declined", reason: e instanceof Error ? e.message : "could not build the transfer", retryable: false };
  }
  // Signed by the relayer now, so the wallet leaves the message as built.
  const relayerSigned = withSignature(unsigned.wire, feePayer.address, feePayer.sign(unsigned.message));
  const transfer: Transfer = {
    owner: input.owner,
    deposit: input.deposit,
    amount: input.amount.toString(),
    wire: b64(relayerSigned),
    message: hex(unsigned.message),
    lastValidBlockHeight: lifetime.lastValidBlockHeight,
    createsAccount,
    costLamports,
    preparedAt: deps.now,
    signature: null,
  };
  // Counted now: from here the merchant holds a transaction the relayer pays for.
  state = {
    ...state,
    transfers: { ...state.transfers, [input.order]: transfer },
    spentLamports: state.spentLamports + costLamports,
    perOwner: { ...state.perOwner, [input.owner]: sentToday + 1 },
  };
  ledger.write(state);
  return { status: "prepared", wire: transfer.wire, lastValidBlockHeight: transfer.lastValidBlockHeight, createsAccount };
}

export async function submitCashout(order: string, signedWire: Uint8Array, deps: CashoutDeps): Promise<Submitted> {
  const { rpc, feePayer, ledger } = deps;
  let state: LedgerState = rollDay(ledger.read(), utcDay(deps.now));
  const transfer = state.transfers?.[order];
  if (!transfer) return { status: "declined", reason: "prepare this cash-out first", retryable: false };
  if (transfer.signature) return { status: "sent", signature: transfer.signature };

  const checked = checkOwnerSigned(unsignedOf(transfer, feePayer.address), signedWire, transfer.owner);
  if (!checked.ok) return { status: "declined", reason: checked.reason, retryable: false };
  if ((await rpc.blockHeight()) > transfer.lastValidBlockHeight) {
    return { status: "declined", reason: "this transfer is too old to land; prepare it again", retryable: true };
  }

  const relayerSignature = feePayer.sign(fromHex(transfer.message));
  const wire = withSignature(checked.wire, feePayer.address, relayerSignature);
  const signature = encodeBase58(relayerSignature);

  // Written before it is sent, as for redemptions: a crash after sending with
  // nothing on disk is a transfer nobody knows about.
  const sentState: LedgerState = {
    ...state,
    transfers: { ...state.transfers, [order]: { ...transfer, signature } },
  };
  ledger.write(sentState);

  let sent: { ok: true } | { ok: false; err: unknown };
  try {
    sent = await rpc.send(b64(wire));
  } catch {
    return { status: "sent", signature };
  }
  if (!sent.ok) {
    // Refused in simulation: nothing landed and nothing was spent. Undo, so a
    // corrected attempt can be prepared.
    state = sentState;
    ledger.write({
      ...state,
      transfers: { ...state.transfers, [order]: { ...transfer, signature: null, lastValidBlockHeight: -1 } },
      spentLamports: Math.max(0, state.spentLamports - transfer.costLamports),
      perOwner: { ...state.perOwner, [transfer.owner]: Math.max(0, (state.perOwner?.[transfer.owner] ?? 1) - 1) },
    });
    return { status: "rejected", err: sent.err };
  }
  return { status: "sent", signature };
}
