/**
 * The offline queue: the vouchers a merchant has taken and not yet been paid
 * for, and what to do about each one when the network comes back.
 *
 * ## What it holds, and why that makes durable nonces unnecessary
 *
 * The queue holds **vouchers**, not signed transactions. A transaction is built
 * and signed only at the moment it is sent, with a fresh blockhash, so nothing
 * queued can go stale except the voucher itself, and the voucher's own
 * `expiresAt` is the only deadline that matters. Durable nonce accounts exist
 * to keep a transaction signed *offline* valid until it can be sent. Nothing
 * here is signed offline, so they would add an account per merchant and a
 * nonce-advance instruction per redemption and buy nothing.
 *
 * ## The failure it is built around
 *
 * The expensive mistake is not a missed retry. It is sending a redemption,
 * losing track of whether it landed, sending it again, and reading the
 * second attempt's `SequenceAlreadyRedeemed` as "someone else was paid". The
 * merchant would be told they were defrauded by a sale they were paid for.
 *
 * So:
 *
 *   - a signature is recorded **before** its transaction leaves the phone
 *     (`sent`), so a crash between the two leaves a signature to look up
 *     rather than an attempt nobody knows about;
 *   - an entry with an attempt still unaccounted for is looked up, never
 *     resent (`plan`);
 *   - "already redeemed" is only believed once every attempt of our own is
 *     known not to have landed (`failed`, `dropped`).
 *
 * Everything here is pure: entries in, entries out, the clock passed in.
 * Storage is the app's (SQLite), and the I/O is `settle.ts`'s.
 */
import { decode, encodeBase58 } from "@nelo/voucher";
import { classify, type Verdict } from "./errors.ts";

export type Status =
  /** Waiting to be sent, or sent and waiting to be looked up. */
  | "pending"
  | "settled"
  /** The chain said no, for good. */
  | "refused"
  /** Its expiry passed before it settled. */
  | "expired"
  /** A person has to look. Kept, not retried, not given up on. */
  | "held";

export interface Attempt {
  signature: string;
  /** Unix milliseconds, when the signature was recorded. */
  sentAt: number;
}

export interface Entry {
  /** `${vault}:${seq}` — one voucher per sequence per vault can ever settle. */
  id: string;
  /** The 202-byte voucher exactly as received. */
  packet: Uint8Array;
  vault: string;
  merchant: string;
  seq: bigint;
  amount: bigint;
  /** Unix seconds, from the voucher. */
  expiresAt: bigint;
  /** Unix milliseconds, when the merchant took it. */
  takenAt: number;
  status: Status;
  /** Transactions sent for it so far. */
  attempts: number;
  /** Unix milliseconds. Not sent again before this. */
  nextAttemptAt: number;
  /** Attempts whose outcome is not yet known. */
  inFlight: readonly Attempt[];
  settledSignature: string | null;
  /** Why it is waiting, or why it stopped. */
  verdict: Verdict | null;
  /**
   * The chain said this sequence was already redeemed while an attempt of our
   * own was unaccounted for. That attempt may be the one that redeemed it.
   */
  awaitingOwnAttempts: boolean;
  updatedAt: number;
}

export interface QueuePolicy {
  /** First retry after a network-shaped failure; doubles each attempt. */
  transientBaseMs: number;
  transientCapMs: number;
  /** First retry when chain state says not yet; doubles each attempt. */
  blockedBaseMs: number;
  blockedCapMs: number;
  /**
   * How long after sending a signature may still be "not found" before it is
   * taken never to have landed. A blockhash lives about 150 slots, roughly 60
   * to 90 seconds, after which the transaction can no longer be processed.
   */
  dropAfterMs: number;
  /**
   * The phone's clock and the chain's disagree, and the chain's is the one
   * that counts. Keep trying for this long past expiry: the program answers
   * `VoucherExpired` if it really is too late, and that costs one fee, where
   * giving up early costs the sale.
   */
  expiryGraceSeconds: number;
  /** Redemptions sent per round. */
  maxSubmitPerRound: number;
}

export const DEFAULT_POLICY: QueuePolicy = {
  transientBaseMs: 15_000,
  transientCapMs: 10 * 60_000,
  blockedBaseMs: 5 * 60_000,
  blockedCapMs: 60 * 60_000,
  dropAfterMs: 120_000,
  expiryGraceSeconds: 300,
  maxSubmitPerRound: 5,
};

export function entryId(vault: string, seq: bigint): string {
  return `${vault}:${seq}`;
}

export type Enqueued =
  | { kind: "added"; entry: Entry }
  /** The same bytes again — a rescan, a double tap. Nothing to do. */
  | { kind: "duplicate"; entry: Entry }
  /**
   * A *different* voucher at a sequence this till already holds. The payer's
   * device signed twice for one slot, and the two packets together are the
   * proof `report_conflict` takes. Not queued: only one of them can ever settle,
   * and the one already held got here first.
   */
  | { kind: "conflict"; existing: Entry; incoming: Uint8Array };

/**
 * Add a voucher the merchant has taken.
 *
 * This is not where the decision to take it is made — `@nelo/accept` does that,
 * before the sale — and it does not repeat those checks. It decodes, so bytes
 * that are not a voucher throw here rather than failing on chain later.
 */
export function enqueue(
  find: (id: string) => Entry | undefined,
  packet: Uint8Array,
  nowMs: number,
): Enqueued {
  const v = decode(packet);
  const vault = encodeBase58(v.vault);
  const id = entryId(vault, v.seq);

  const existing = find(id);
  if (existing) {
    return sameBytes(existing.packet, packet)
      ? { kind: "duplicate", entry: existing }
      : { kind: "conflict", existing, incoming: packet.slice() };
  }

  return {
    kind: "added",
    entry: {
      id,
      packet: packet.slice(),
      vault,
      merchant: encodeBase58(v.merchant),
      seq: v.seq,
      amount: v.amount,
      expiresAt: v.expiresAt,
      takenAt: nowMs,
      status: "pending",
      attempts: 0,
      nextAttemptAt: nowMs,
      inFlight: [],
      settledSignature: null,
      verdict: null,
      awaitingOwnAttempts: false,
      updatedAt: nowMs,
    },
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface Plan {
  /** Have attempts in flight: look them up. Never resent while they do. */
  check: Entry[];
  /** Due, in the order to send them. */
  submit: Entry[];
  /** Past expiry and the grace, with nothing in flight. */
  expire: Entry[];
}

/**
 * What to do this round.
 *
 * Submission order is earliest expiry first, so the voucher closest to being
 * lost goes first; then by vault and ascending sequence, because the replay
 * window only advances over contiguous settled slots, so a payer's lower
 * sequences clear the way for the higher ones.
 */
export function plan(entries: readonly Entry[], nowMs: number, policy: QueuePolicy = DEFAULT_POLICY): Plan {
  const nowSeconds = BigInt(Math.floor(nowMs / 1000));
  const grace = BigInt(policy.expiryGraceSeconds);
  const check: Entry[] = [];
  const due: Entry[] = [];
  const expire: Entry[] = [];

  for (const e of entries) {
    if (e.status !== "pending") continue;
    if (e.inFlight.length > 0) check.push(e);
    else if (nowSeconds > e.expiresAt + grace) expire.push(e);
    else if (e.nextAttemptAt <= nowMs) due.push(e);
  }

  due.sort((a, b) =>
    a.expiresAt !== b.expiresAt
      ? a.expiresAt < b.expiresAt ? -1 : 1
      : a.vault !== b.vault
        ? a.vault < b.vault ? -1 : 1
        : a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0,
  );

  return { check, submit: due.slice(0, policy.maxSubmitPerRound), expire };
}

function backoff(base: number, cap: number, attempts: number): number {
  // attempts is at least 1 by the time anything fails.
  const exponent = Math.min(Math.max(attempts - 1, 0), 30);
  return Math.min(base * 2 ** exponent, cap);
}

function touch(e: Entry, nowMs: number, patch: Partial<Entry>): Entry {
  return { ...e, ...patch, updatedAt: nowMs };
}

function without(inFlight: readonly Attempt[], signature: string): Attempt[] {
  return inFlight.filter((a) => a.signature !== signature);
}

function requirePending(e: Entry, what: string): void {
  if (e.status !== "pending") throw new Error(`${what}: ${e.id} is ${e.status}, not pending`);
}

/**
 * Record a signature **before** its transaction is sent. The order is the
 * whole point: see the note at the top of this file.
 */
export function sent(e: Entry, signature: string, nowMs: number): Entry {
  requirePending(e, "sent");
  if (e.inFlight.some((a) => a.signature === signature)) return e;
  return touch(e, nowMs, {
    attempts: e.attempts + 1,
    inFlight: [...e.inFlight, { signature, sentAt: nowMs }],
  });
}

/** The chain confirmed one of our attempts. */
export function landed(e: Entry, signature: string, nowMs: number): Entry {
  // Settled is terminal and final: a confirmation can arrive for an entry that
  // was expired locally, and the chain is the one that knows.
  return touch(e, nowMs, {
    status: "settled",
    settledSignature: signature,
    inFlight: [],
    awaitingOwnAttempts: false,
    verdict: null,
  });
}

/**
 * An attempt failed, on chain or in preflight simulation. `err` is the RPC's
 * transaction error.
 */
export function failed(
  e: Entry,
  signature: string,
  err: unknown,
  nowMs: number,
  policy: QueuePolicy = DEFAULT_POLICY,
): Entry {
  requirePending(e, "failed");
  const verdict = classify(err);

  // It may have landed after all. Leave it in flight to be looked up.
  if (verdict.kind === "check") return touch(e, nowMs, { verdict });

  const inFlight = without(e.inFlight, signature);

  if (verdict.kind === "refused" && verdict.reason === "paid-to-someone-else" && inFlight.length > 0) {
    // One of our own other attempts may be what redeemed this sequence.
    return touch(e, nowMs, { inFlight, verdict, awaitingOwnAttempts: true });
  }

  switch (verdict.kind) {
    case "refused":
      return touch(e, nowMs, { status: "refused", inFlight, verdict });
    case "held":
      return touch(e, nowMs, { status: "held", inFlight, verdict });
    case "blocked":
      return touch(e, nowMs, {
        inFlight,
        verdict,
        nextAttemptAt: nowMs + backoff(policy.blockedBaseMs, policy.blockedCapMs, e.attempts),
      });
    case "transient":
      return touch(e, nowMs, {
        inFlight,
        verdict,
        nextAttemptAt: nowMs + backoff(policy.transientBaseMs, policy.transientCapMs, e.attempts),
      });
  }
}

/**
 * The send could not reach the network. Whether the transaction left the phone
 * is unknown, so the attempt stays in flight and is looked up, not resent.
 */
export function unreachable(e: Entry, message: string, nowMs: number): Entry {
  requirePending(e, "unreachable");
  return touch(e, nowMs, { verdict: { kind: "transient", reason: "network", detail: message } });
}

/** Looked up, not found, and too old to still land: it never will. */
export function dropped(e: Entry, signature: string, nowMs: number): Entry {
  requirePending(e, "dropped");
  const inFlight = without(e.inFlight, signature);

  if (e.awaitingOwnAttempts && inFlight.length === 0) {
    // Every attempt of ours is accounted for and none landed, so the earlier
    // "already redeemed" was somebody else's redemption.
    return touch(e, nowMs, {
      status: "refused",
      inFlight,
      awaitingOwnAttempts: false,
      verdict: classify({ InstructionError: [1, { Custom: 6010 }] }),
    });
  }
  return touch(e, nowMs, {
    inFlight,
    nextAttemptAt: inFlight.length === 0 ? nowMs : e.nextAttemptAt,
    verdict: { kind: "transient", reason: "rpc", detail: "The last attempt never landed; sending again." },
  });
}

/** Past expiry and the grace, with nothing in flight. */
export function expire(e: Entry, nowMs: number): Entry {
  requirePending(e, "expire");
  if (e.inFlight.length > 0) throw new Error(`expire: ${e.id} has attempts in flight; look them up first`);
  return touch(e, nowMs, {
    status: "expired",
    verdict: { kind: "refused", reason: "expired", detail: "The voucher expired before it could be settled." },
  });
}

/** A person has looked at a held entry and wants it tried again. */
export function release(e: Entry, nowMs: number): Entry {
  if (e.status !== "held") throw new Error(`release: ${e.id} is ${e.status}, not held`);
  return touch(e, nowMs, { status: "pending", nextAttemptAt: nowMs, verdict: null });
}

/** What the merchant is still owed, in token base units, by status. */
export function outstanding(entries: readonly Entry[]): { pending: bigint; held: bigint } {
  let pending = 0n;
  let held = 0n;
  for (const e of entries) {
    if (e.status === "pending") pending += e.amount;
    else if (e.status === "held") held += e.amount;
  }
  return { pending, held };
}
