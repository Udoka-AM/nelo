/**
 * The day-book.
 *
 * This is the screen a merchant actually lives in — not the payment screen,
 * which they see for thirty seconds a day. It is also the thing that has to be
 * right: a trader reconciles cash against this at close, and a total that is
 * off by a hundredth of a naira is a conversation you do not want to have at a
 * stall.
 *
 * Everything here is pure and integer-only. Storage lives in the app; totals,
 * day boundaries and close-of-day do not, because they are where the bugs are.
 */

export interface Sale {
  /** The Solana Pay reference — unique per sale, so it doubles as the id. */
  reference: string;
  signature: string;
  /** What the merchant charged, in local minor units. */
  localMinor: bigint;
  currency: string;
  /** What actually arrived, in token base units. */
  amountBaseUnits: bigint;
  mint: string;
  /** Unix milliseconds, device clock. */
  at: number;
  overpaid: boolean;
}

/**
 * The calendar day a sale belongs to, as `YYYY-MM-DD`.
 *
 * A merchant's day is their local day. A sale at 23:50 belongs to that day, not
 * to tomorrow because UTC has already rolled over — get this wrong and the
 * close-of-day total silently disagrees with the cash in the tin.
 *
 * The offset is passed in rather than read from the environment so this is
 * deterministic under test; the app supplies `-new Date().getTimezoneOffset()`.
 */
export function localDayKey(atMs: number, tzOffsetMinutes: number): string {
  const shifted = new Date(atMs + tzOffsetMinutes * 60_000);
  const y = shifted.getUTCFullYear();
  const m = `${shifted.getUTCMonth() + 1}`.padStart(2, "0");
  const d = `${shifted.getUTCDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export interface DayTotals {
  day: string;
  count: number;
  /** Sum of what was charged, in local minor units. */
  localMinor: bigint;
  /** Sum of what arrived, in token base units. */
  amountBaseUnits: bigint;
  /** Sales where the customer paid more than asked. Worth surfacing, not hiding. */
  overpaidCount: number;
}

export function totalsFor(sales: readonly Sale[]): Omit<DayTotals, "day"> {
  let localMinor = 0n;
  let amountBaseUnits = 0n;
  let overpaidCount = 0;
  for (const sale of sales) {
    localMinor += sale.localMinor;
    amountBaseUnits += sale.amountBaseUnits;
    if (sale.overpaid) overpaidCount++;
  }
  return { count: sales.length, localMinor, amountBaseUnits, overpaidCount };
}

/** Sales grouped into days, newest day first, newest sale first within a day. */
export function groupByDay(
  sales: readonly Sale[],
  tzOffsetMinutes: number,
): { day: string; sales: Sale[]; totals: DayTotals }[] {
  const buckets = new Map<string, Sale[]>();
  for (const sale of sales) {
    const day = localDayKey(sale.at, tzOffsetMinutes);
    const bucket = buckets.get(day);
    if (bucket) bucket.push(sale);
    else buckets.set(day, [sale]);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([day, daySales]) => {
      const sorted = [...daySales].sort((a, b) => b.at - a.at);
      return { day, sales: sorted, totals: { day, ...totalsFor(sorted) } };
    });
}

/** Everything taken on one local day. */
export function salesOn(
  sales: readonly Sale[],
  day: string,
  tzOffsetMinutes: number,
): Sale[] {
  return sales
    .filter((sale) => localDayKey(sale.at, tzOffsetMinutes) === day)
    .sort((a, b) => b.at - a.at);
}

/**
 * What the merchant reads at close of day, and reconciles against the tin.
 */
export function closeOfDay(
  sales: readonly Sale[],
  day: string,
  tzOffsetMinutes: number,
): DayTotals {
  return { day, ...totalsFor(salesOn(sales, day, tzOffsetMinutes)) };
}

/** A short, human time for a row: "14:05". */
export function formatTime(atMs: number, tzOffsetMinutes: number): string {
  const shifted = new Date(atMs + tzOffsetMinutes * 60_000);
  const h = `${shifted.getUTCHours()}`.padStart(2, "0");
  const m = `${shifted.getUTCMinutes()}`.padStart(2, "0");
  return `${h}:${m}`;
}

/** "Today", "Yesterday", or the date itself. */
export function dayLabel(day: string, nowMs: number, tzOffsetMinutes: number): string {
  const today = localDayKey(nowMs, tzOffsetMinutes);
  if (day === today) return "Today";
  const yesterday = localDayKey(nowMs - 86_400_000, tzOffsetMinutes);
  if (day === yesterday) return "Yesterday";
  return day;
}
