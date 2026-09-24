/**
 * Close of day, with offline payments in it.
 *
 * The day-book holds money that has arrived. Offline, a merchant hands goods
 * over hours or days before the money does, and sometimes it never comes. So
 * the close has to say four things about what was sold today: what is in,
 * what is still coming, what someone has to look at, and what is lost. A till
 * that shows only the first is one where a merchant finds out about the last
 * weeks later.
 *
 * It also checks the till's two records against each other. An offline
 * payment that settled is in both: the queue says it settled, and the
 * day-book has a row for it. When they disagree, one of them is wrong, and
 * the close says so instead of picking one.
 */
import { localDayKey, type Sale } from "./index.ts";

export interface OfflinePayment {
  /** `${vault}:${seq}`. Also its day-book reference, once it settles. */
  id: string;
  /** Unix milliseconds, when the goods changed hands. */
  takenAt: number;
  /** What the merchant charged, in local minor units. */
  localMinor: bigint;
  /** What the voucher pays, in token base units. */
  amountBaseUnits: bigint;
  state: "settled" | "owed" | "held" | "lost";
  /** Why it is waiting, held or lost, in words for the merchant. */
  why?: string | null;
}

export interface Tally {
  count: number;
  localMinor: bigint;
  amountBaseUnits: bigint;
}

export type Mismatch =
  /** The queue says it settled; the day-book has no row for it. */
  | { kind: "settled-not-booked"; id: string }
  /** The day-book has a row for it; the queue says it has not settled. */
  | { kind: "booked-not-settled"; id: string }
  /** The day-book has a row for an offline payment the queue never took. */
  | { kind: "booked-unknown"; id: string }
  /** Both have it, with different figures. */
  | { kind: "amount-differs"; id: string };

export interface DayClose {
  day: string;
  /** Everything sold today, however it was paid and whatever became of it. */
  sold: Tally;
  received: { online: Tally; offline: Tally; total: Tally };
  owed: Tally & { items: OfflinePayment[] };
  held: Tally & { items: OfflinePayment[] };
  lost: Tally & { items: OfflinePayment[] };
  /** Taken on earlier days and still not in. Not part of today's figures. */
  earlierOwed: Tally;
  /** Empty when the till's two records agree. */
  mismatches: Mismatch[];
}

const zero = (): Tally => ({ count: 0, localMinor: 0n, amountBaseUnits: 0n });

function add(t: Tally, x: { localMinor: bigint; amountBaseUnits: bigint }): Tally {
  return { count: t.count + 1, localMinor: t.localMinor + x.localMinor, amountBaseUnits: t.amountBaseUnits + x.amountBaseUnits };
}

const sum = (a: Tally, b: Tally): Tally => ({
  count: a.count + b.count,
  localMinor: a.localMinor + b.localMinor,
  amountBaseUnits: a.amountBaseUnits + b.amountBaseUnits,
});

/** Offline payment ids are `vault:seq`; a Solana Pay reference never has a colon. */
const looksOffline = (reference: string) => reference.includes(":");

export function reconcileDay(
  sales: readonly Sale[],
  offline: readonly OfflinePayment[],
  day: string,
  tzOffsetMinutes: number,
): DayClose {
  const onDay = (at: number) => localDayKey(at, tzOffsetMinutes) === day;
  const byId = new Map(offline.map((p) => [p.id, p]));
  const booked = new Map(sales.map((s) => [s.reference, s]));
  const mismatches: Mismatch[] = [];

  let online = zero();
  for (const s of sales) {
    if (!onDay(s.at)) continue;
    const p = byId.get(s.reference);
    if (!p) {
      if (looksOffline(s.reference)) mismatches.push({ kind: "booked-unknown", id: s.reference });
      else online = add(online, s);
      continue;
    }
    if (p.state !== "settled") mismatches.push({ kind: "booked-not-settled", id: p.id });
  }

  let received = zero();
  const owed = { ...zero(), items: [] as OfflinePayment[] };
  const held = { ...zero(), items: [] as OfflinePayment[] };
  const lost = { ...zero(), items: [] as OfflinePayment[] };
  let earlierOwed = zero();
  let taken = zero();

  for (const p of offline) {
    if (!onDay(p.takenAt)) {
      // Only what is still coming carries over; earlier days' losses were
      // reported on those days.
      if (p.state === "owed" || p.state === "held") {
        if (localDayKey(p.takenAt, tzOffsetMinutes) < day) earlierOwed = add(earlierOwed, p);
      }
      continue;
    }
    taken = add(taken, p);
    const row = booked.get(p.id);
    if (p.state === "settled") {
      received = add(received, p);
      if (!row) mismatches.push({ kind: "settled-not-booked", id: p.id });
      else if (row.localMinor !== p.localMinor || row.amountBaseUnits !== p.amountBaseUnits) {
        mismatches.push({ kind: "amount-differs", id: p.id });
      }
      continue;
    }
    const bucket = p.state === "owed" ? owed : p.state === "held" ? held : lost;
    Object.assign(bucket, add(bucket, p));
    bucket.items.push(p);
  }

  for (const b of [owed, held, lost]) b.items.sort((x, y) => y.takenAt - x.takenAt);

  return {
    day,
    sold: sum(online, taken),
    received: { online, offline: received, total: sum(online, received) },
    owed,
    held,
    lost,
    earlierOwed,
    mismatches,
  };
}
