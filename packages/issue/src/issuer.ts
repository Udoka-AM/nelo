/**
 * Issuing vouchers on the payer's phone.
 *
 * ## The one rule
 *
 * **A sequence number is never signed over two different messages.** Two
 * different vouchers at one sequence, both signed by the enrolled key, are
 * exactly what `report_conflict` takes as proof of a double spend. Anyone
 * holding the pair can freeze the vault, and `slash` then takes the stake. A
 * payer's own phone producing that pair by accident — after a crash, a retry,
 * a double tap — would be the product defrauding its own user.
 *
 * So issuing is two steps with a durable write between them:
 *
 *   1. {@link prepare} fixes every field of the next voucher, salt included,
 *      and advances the counter. The caller **persists that state** before
 *      anything is signed.
 *   2. {@link complete} takes the signature over exactly those bytes.
 *
 * A crash between the two leaves a pending voucher whose bytes are already
 * fixed. {@link pendingMessage} hands back the same 105 bytes to sign again.
 * Signing the same message twice is harmless: the program compares messages,
 * not signatures, and refuses two identical ones as `NotAConflict`. What must
 * never happen is fixing *new* fields at a sequence that may already have been
 * signed, and nothing here can do that — `prepare` refuses while a voucher is
 * pending.
 *
 * ## What else it refuses
 *
 * An honest device protects its payer and the merchant from vouchers the chain
 * will not pay:
 *
 *   - more than the payer's collateral, less what they have already promised;
 *   - above the offline limit;
 *   - while a withdrawal is pending: the collateral may leave before the
 *     voucher is redeemed;
 *   - from a frozen vault;
 *   - once 128 vouchers are outstanding, the most the replay window can hold.
 *
 * Expiry is bounded by the withdrawal timelock for the same reason as the
 * withdrawal refusal. A voucher must not outlive the collateral backing it.
 *
 * Pure: state in, state out. `session.ts` does the storage and signing.
 */
import {
  decodeBase58,
  encode,
  encodeBase58,
  isLowS,
  signedMessage,
  verify,
  VOUCHER_VERSION,
  type Voucher,
} from "@nelo/voucher";

/** Mirrors `REPLAY_WINDOW`. */
export const REPLAY_WINDOW = 128n;
/** Mirrors `WITHDRAW_TIMELOCK_SECONDS`. */
export const WITHDRAW_TIMELOCK_SECONDS = 86_400;
/** Mirrors `VAULT_STATUS_FROZEN`. */
export const VAULT_STATUS_FROZEN = 1;

/** What the payer's phone last read from its own vault account. */
export interface ChainView {
  balance: bigint;
  seqBase: bigint;
  seqBitmap: bigint;
  /** Unix seconds; 0 means no withdrawal requested. */
  unlockAt: bigint;
  status: number;
  /** The limit the chain would grant right now, from `@nelo/accept`'s `limitFor`. */
  limit: bigint;
  /** Unix seconds. */
  syncedAt: number;
}

/** A voucher signed and handed over, not yet known to be redeemed. */
export interface Outstanding {
  seq: bigint;
  amount: bigint;
  merchant: string;
  expiresAt: bigint;
}

export type Fields = Omit<Voucher, "signature" | "devicePubkey">;

export interface IssuerState {
  /** base58. */
  vault: string;
  /** SEC1 compressed. The StrongBox key's public half. */
  devicePubkey: Uint8Array;
  /** The next sequence to use. Only ever moves forward. */
  nextSeq: bigint;
  chain: ChainView;
  outstanding: readonly Outstanding[];
  /** Fixed, persisted, and not yet signed. */
  pending: Fields | null;
}

export interface IssuePolicy {
  /** How long a voucher stays redeemable. */
  ttlSeconds: number;
}

/**
 * Twelve hours: long enough for a merchant in a dead zone to get home, well
 * inside the 24-hour withdrawal timelock.
 */
export const DEFAULT_ISSUE_POLICY: IssuePolicy = { ttlSeconds: 12 * 60 * 60 };

export function initialState(vault: string, devicePubkey: Uint8Array, chain: ChainView): IssuerState {
  if (devicePubkey.length !== 33) throw new Error("device key must be 33 bytes, SEC1 compressed");
  return { vault, devicePubkey, nextSeq: firstFreeAbove(chain), chain, outstanding: [], pending: null };
}

/** One past the highest sequence the chain has seen redeemed. */
function firstFreeAbove(chain: ChainView): bigint {
  let highest = -1n;
  for (let slot = 0n; slot < REPLAY_WINDOW; slot++) {
    if ((chain.seqBitmap >> slot) & 1n) highest = slot;
  }
  return chain.seqBase + highest + 1n;
}

function redeemedOnChain(chain: ChainView, seq: bigint): boolean {
  if (seq < chain.seqBase) return true;
  const slot = seq - chain.seqBase;
  return slot < REPLAY_WINDOW && ((chain.seqBitmap >> slot) & 1n) === 1n;
}

/** Collateral less every voucher still outstanding: what the payer can promise. */
export function spendable(state: IssuerState): bigint {
  const promised = state.outstanding.reduce((sum, o) => sum + o.amount, 0n);
  const pending = state.pending?.amount ?? 0n;
  const left = state.chain.balance - promised - pending;
  return left > 0n ? left : 0n;
}

/**
 * Fold in a fresh read of the vault. Vouchers the chain has redeemed stop
 * being outstanding, because the balance now reflects them. Vouchers that
 * expired unredeemed stop too: they can never be paid, so their amount is
 * spendable again.
 *
 * The counter never moves backwards. The chain only knows what has been
 * redeemed. The phone knows what it has signed, and that is always at least as
 * far along.
 */
export function applyChain(state: IssuerState, chain: ChainView): IssuerState {
  if (chain.syncedAt < state.chain.syncedAt) return state;
  const nowSeconds = BigInt(chain.syncedAt);
  const outstanding = state.outstanding.filter(
    (o) => !redeemedOnChain(chain, o.seq) && o.expiresAt >= nowSeconds,
  );
  const fromChain = firstFreeAbove(chain);
  return {
    ...state,
    chain,
    outstanding,
    nextSeq: fromChain > state.nextSeq ? fromChain : state.nextSeq,
  };
}

export interface IssueRequest {
  /** base58, the payee. */
  merchant: string;
  amount: bigint;
  /** Unix seconds. */
  now: number;
}

export type Prepared =
  | { ok: true; state: IssuerState; fields: Fields; message: Uint8Array }
  | { ok: false; reason: string };

/**
 * Fix the next voucher's bytes. The caller must persist `state` before signing
 * `message` — see the note at the top of this file.
 */
export function prepare(
  state: IssuerState,
  request: IssueRequest,
  salt: Uint8Array,
  policy: IssuePolicy = DEFAULT_ISSUE_POLICY,
): Prepared {
  const no = (reason: string): Prepared => ({ ok: false, reason });

  if (state.pending) {
    return no("A voucher is already being signed. Finish it before starting another.");
  }
  if (salt.length !== 8) throw new Error("salt must be 8 bytes");
  if (policy.ttlSeconds <= 0 || policy.ttlSeconds >= WITHDRAW_TIMELOCK_SECONDS) {
    throw new Error("a voucher must expire inside the withdrawal timelock");
  }
  if (request.amount <= 0n) return no("The amount must be more than zero.");
  if (state.chain.status === VAULT_STATUS_FROZEN) return no("This vault is frozen and cannot pay.");
  if (state.chain.unlockAt !== 0n) {
    return no("A withdrawal is pending. Cancel it or wait for it to finish before paying offline.");
  }
  if (request.amount > state.chain.limit) {
    return no(`Above your offline limit of ${state.chain.limit}.`);
  }
  if (request.amount > spendable(state)) {
    return no(`Not enough left to promise: ${spendable(state)} is available.`);
  }
  if (state.nextSeq - state.chain.seqBase >= REPLAY_WINDOW) {
    return no("Too many payments are waiting to settle. Reconnect so merchants can redeem them first.");
  }

  let merchant: Uint8Array;
  try {
    merchant = decodeAddress(request.merchant);
  } catch {
    return no("That is not a merchant address.");
  }

  const remainingAfter = spendable(state) - request.amount;
  const fields: Fields = {
    version: VOUCHER_VERSION,
    vault: decodeAddress(state.vault),
    seq: state.nextSeq,
    amount: request.amount,
    remainingAfter,
    merchant,
    expiresAt: BigInt(request.now + policy.ttlSeconds),
    salt: salt.slice(),
  };
  return {
    ok: true,
    fields,
    message: signedMessage(fields),
    state: { ...state, nextSeq: state.nextSeq + 1n, pending: fields },
  };
}

/** The exact bytes to sign for the pending voucher, after a crash or a failed signature. */
export function pendingMessage(state: IssuerState): Uint8Array | null {
  return state.pending ? signedMessage(state.pending) : null;
}

export type Completed = { ok: true; state: IssuerState; packet: Uint8Array } | { ok: false; reason: string };

/**
 * Attach the signature. It is checked against the enrolled key before the
 * voucher leaves the phone. A signature the chain would refuse must not reach
 * a merchant who is about to hand over goods for it.
 */
export function complete(state: IssuerState, signature: Uint8Array): Completed {
  const fields = state.pending;
  if (!fields) return { ok: false, reason: "Nothing is waiting to be signed." };
  if (signature.length !== 64) return { ok: false, reason: "The signature is not 64 bytes." };
  if (!isLowS(signature)) {
    return { ok: false, reason: "The signature is high-S; the precompile would refuse it." };
  }
  const voucher: Voucher = { ...fields, signature, devicePubkey: state.devicePubkey };
  if (!verify(voucher)) {
    // Kept pending: signing the same bytes again is safe, and is the fix.
    return { ok: false, reason: "The signature does not verify against the enrolled key." };
  }
  return {
    ok: true,
    packet: encode(voucher),
    state: {
      ...state,
      pending: null,
      outstanding: [
        ...state.outstanding,
        {
          seq: fields.seq,
          amount: fields.amount,
          merchant: encodeBase58(fields.merchant),
          expiresAt: fields.expiresAt,
        },
      ],
    },
  };
}

function decodeAddress(address: string): Uint8Array {
  const bytes = decodeBase58(address);
  if (bytes.length !== 32) throw new Error("not a 32-byte address");
  return bytes;
}
