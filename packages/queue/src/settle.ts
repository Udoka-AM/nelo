/**
 * Settle on reconnect: one round of the queue against the network.
 *
 * The app calls {@link settleOnce} when connectivity returns and then on a
 * timer while anything is pending. Each round looks up what is in flight,
 * expires what is past saving, and sends what is due. It stops at the first
 * sign the network is gone rather than signing transactions it cannot send.
 *
 * Signing is behind {@link SettleDeps.prepare} on purpose. Who pays the fee and
 * signs — the merchant's embedded wallet, or the relayer — is still an open
 * decision, and this module should not make it. It only needs the signature
 * before the transaction is sent.
 */
import {
  dropped,
  expire,
  failed,
  landed,
  plan,
  sent,
  unreachable,
  DEFAULT_POLICY,
  type Entry,
  type QueuePolicy,
} from "./queue.ts";

export interface Store {
  all(): Promise<Entry[]>;
  /** Must be durable when it resolves: `settleOnce` sends only after it does. */
  put(entry: Entry): Promise<void>;
}

export type SendResult =
  | { kind: "sent" }
  /** Refused before landing, usually by preflight simulation. */
  | { kind: "rejected"; err: unknown }
  /** The request did not complete. It may or may not have gone out. */
  | { kind: "unreachable"; message: string };

export interface Prepared {
  /** Known before anything leaves the phone. */
  signature: string;
  send(): Promise<SendResult>;
}

/**
 * Nothing was built or sent, for a reason that is not the network: a relayer
 * that declines the voucher, say. `err` is classified like any transaction
 * error, so a relayer can mark a refusal as worth retrying or not.
 */
export interface Declined {
  declined: unknown;
}

export type SignatureStatus =
  | { kind: "confirmed" }
  | { kind: "failed"; err: unknown }
  /** Seen, not yet at the commitment asked for. */
  | { kind: "processing" }
  | { kind: "not-found" };

export interface SettleDeps {
  /**
   * Build the redemption (`@nelo/redeem`), fetch a blockhash, sign — and do
   * not send. Throw if the network is unreachable. Return `Declined` when
   * something reachable refuses to take it further.
   */
  prepare(entry: Entry): Promise<Prepared | Declined>;
  /**
   * `getSignatureStatuses` with `searchTransactionHistory: true`, at confirmed
   * commitment. Without the history search, a transaction that landed more
   * than a few minutes ago reads as not found, and would be sent again.
   * Throw if the network is unreachable.
   */
  statuses(signatures: readonly string[]): Promise<ReadonlyMap<string, SignatureStatus>>;
  now(): number;
}

export interface RoundReport {
  /** Could not reach the network. Nothing was sent. */
  offline: boolean;
  settled: Entry[];
  refused: Entry[];
  held: Entry[];
  expired: Entry[];
  /** Transactions sent this round. */
  sent: number;
}

/**
 * One round. Safe to call at any time, including twice at once from a
 * reconnect event and a timer. The worst case is one extra lookup: nothing is
 * sent for an entry that already has an attempt in flight.
 */
export async function settleOnce(
  store: Store,
  deps: SettleDeps,
  policy: QueuePolicy = DEFAULT_POLICY,
): Promise<RoundReport> {
  const report: RoundReport = { offline: false, settled: [], refused: [], held: [], expired: [], sent: 0 };
  const note = (e: Entry) => {
    if (e.status === "settled") report.settled.push(e);
    else if (e.status === "refused") report.refused.push(e);
    else if (e.status === "held") report.held.push(e);
    else if (e.status === "expired") report.expired.push(e);
  };

  const work = plan(await store.all(), deps.now(), policy);

  // 1. Account for every attempt already out there. This comes first because
  //    until it is done, sending anything for these entries risks paying twice
  //    in fees and misreading our own success as a double spend.
  if (work.check.length > 0) {
    const signatures = work.check.flatMap((e) => e.inFlight.map((a) => a.signature));
    let statuses: ReadonlyMap<string, SignatureStatus>;
    try {
      statuses = await deps.statuses(signatures);
    } catch {
      report.offline = true;
      return report;
    }
    for (let e of work.check) {
      for (const attempt of e.inFlight) {
        if (e.status !== "pending") break;
        const status = statuses.get(attempt.signature) ?? { kind: "not-found" };
        const now = deps.now();
        if (status.kind === "confirmed") e = landed(e, attempt.signature, now);
        else if (status.kind === "failed") e = failed(e, attempt.signature, status.err, now, policy);
        else if (status.kind === "not-found" && now - attempt.sentAt >= policy.dropAfterMs) {
          e = dropped(e, attempt.signature, now);
        }
      }
      await store.put(e);
      note(e);
    }
  }

  // 2. Past saving.
  for (const e of work.expire) {
    const next = expire(e, deps.now());
    await store.put(next);
    note(next);
  }

  // 3. Send what is due.
  for (let e of work.submit) {
    let prepared: Prepared | Declined;
    try {
      prepared = await deps.prepare(e);
    } catch {
      report.offline = true;
      return report;
    }
    if ("declined" in prepared) {
      // Nothing is in flight, so this is decided now, like a preflight refusal.
      e = failed(e, "", prepared.declined, deps.now(), policy);
      await store.put(e);
      note(e);
      continue;
    }

    // Durable before it is sent. A crash after this line leaves a signature
    // to look up next round; a crash before it leaves nothing sent.
    e = sent(e, prepared.signature, deps.now());
    await store.put(e);

    const result = await prepared.send();
    const now = deps.now();
    if (result.kind === "sent") {
      report.sent++;
    } else if (result.kind === "rejected") {
      e = failed(e, prepared.signature, result.err, now, policy);
      await store.put(e);
      note(e);
    } else {
      e = unreachable(e, result.message, now);
      await store.put(e);
      report.offline = true;
      return report;
    }
  }

  return report;
}

/** An in-memory store, for tests and for a first cut before SQLite. */
export function memoryStore(initial: readonly Entry[] = []): Store & { get(id: string): Entry | undefined } {
  const byId = new Map(initial.map((e) => [e.id, e]));
  return {
    async all() {
      return [...byId.values()];
    },
    async put(entry) {
      byId.set(entry.id, entry);
    },
    get(id) {
      return byId.get(id);
    },
  };
}
