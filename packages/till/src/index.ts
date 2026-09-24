/**
 * What the till does with a scanned code: every offline check, in order, ending
 * in one answer the screen can render.
 *
 *   QR text → voucher bytes      (`@nelo/voucher`'s `fromQr`)
 *   voucher → cached enrolment   (`@nelo/enrol`'s `lookup`)
 *   enrolment → take or refuse   (`@nelo/accept`)
 *   amount → covers the charge?  (here)
 *
 * The app renders the result and, on "take", queues the packet. Nothing in this
 * file touches the network, the camera or storage, which is why it lives in a
 * package with tests rather than in a screen.
 */
import { accept, type Risk } from "@nelo/accept";
import { lookup, type EnrolmentCache } from "@nelo/enrol";
import type { Entry } from "@nelo/queue";
import { decode, encodeBase58, fromQr, type Voucher } from "@nelo/voucher";

export type Scan =
  /** A code, but not a Nelo payment, or one that did not read cleanly. */
  | { kind: "not-a-voucher"; reason: string }
  /**
   * The till has never synced this payer's vault. Offline, a vault it has
   * never seen is indistinguishable from one that does not exist.
   */
  | { kind: "unknown-vault"; vault: string }
  /** The till has never synced at all. */
  | { kind: "not-synced" }
  | { kind: "refused"; reason: string }
  /** A good voucher for less than the sale. */
  | { kind: "short"; paid: bigint; charged: bigint }
  | { kind: "take"; packet: Uint8Array; voucher: Voucher; amount: bigint; risks: Risk[]; overpaid: boolean };

export interface ScanInput {
  /** Exactly what the scanner returned. */
  text: string;
  cache: EnrolmentCache;
  /** This till's address, base58. */
  merchant: string;
  /** What the merchant charged, in token base units. */
  charged: bigint;
  /** Everything already queued, so a voucher shown twice is caught. */
  queued: readonly Entry[];
  /** Unix seconds. */
  now: number;
}

export function scan(input: ScanInput): Scan {
  const read = fromQr(input.text);
  if (!read.ok) return { kind: "not-a-voucher", reason: read.reason };

  let vault: string;
  try {
    vault = encodeBase58(decode(read.packet).vault);
  } catch (e) {
    return { kind: "not-a-voucher", reason: e instanceof Error ? e.message : "That code is not a Nelo payment." };
  }

  const found = lookup(input.cache, vault);
  if (!found.found) return found.missing === "risk" ? { kind: "not-synced" } : { kind: "unknown-vault", vault };

  const decision = accept({
    bytes: read.packet,
    enrolment: found.enrolment,
    risk: found.risk,
    merchant: input.merchant,
    now: input.now,
    seen: seenFor(input.queued, vault),
  });
  if (!decision.take) return { kind: "refused", reason: decision.reason };

  if (decision.amount < input.charged) {
    return { kind: "short", paid: decision.amount, charged: input.charged };
  }
  return {
    kind: "take",
    packet: read.packet,
    voucher: decision.voucher,
    amount: decision.amount,
    risks: decision.risks,
    overpaid: decision.amount > input.charged,
  };
}

/**
 * What this till already holds from one vault, as `accept` wants it: sequence
 * to the `remainingAfter` its voucher claimed. Every status counts. A settled
 * voucher is as spent as a pending one.
 */
export function seenFor(entries: readonly Entry[], vault: string): Map<bigint, bigint> {
  const seen = new Map<bigint, bigint>();
  for (const e of entries) {
    if (e.vault === vault) seen.set(e.seq, decode(e.packet).remainingAfter);
  }
  return seen;
}

/** One line per risk, for a shopkeeper rather than an engineer. */
export function describeRisk(risk: Risk): string {
  switch (risk.kind) {
    case "stale-enrolment":
      return `Payer details are ${Math.round(risk.ageSeconds / 3600)} hours old. Sync when you can.`;
    case "vault-frozen":
      return "This payer has been caught spending twice. Their money is locked, but others may claim it first.";
    case "collateral-may-be-spent":
      return "Their balance looked short when you last synced. They may have topped up, or may not.";
    case "sequence-unconfirmed":
      return "Paid offline: it settles when you reconnect.";
    case "remaining-disputed":
      return "Their phone's balance does not add up with their last payment to you.";
  }
}
