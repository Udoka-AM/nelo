/**
 * Where a phone that takes vouchers keeps them: the queue, the payer list it
 * checks them against, and any double spend it caught.
 *
 * The merchant's till and a customer receiving from another customer need
 * exactly the same thing, so it is written once, against the few calls
 * `expo-sqlite` and Node's `node:sqlite` share, and tested on the second.
 *
 * Writes resolve only once SQLite has them. `@nelo/queue` relies on that: it
 * stores a redemption's signature before the transaction is sent, so that a
 * crash cannot leave an attempt nobody knows about.
 *
 * Amounts are TEXT: they are bigint everywhere else, and a trip through a JS
 * number is how a ledger acquires a rounding error nobody can explain.
 */
import {
  emptyCache,
  fromRecord as cacheFromRecord,
  toRecord as cacheToRecord,
  type EnrolmentCache,
} from "@nelo/enrol";
import { fromRecord, toRecord, type Entry, type EntryRecord, type Store } from "@nelo/queue";
import { decodeBase64, encodeBase64 } from "@nelo/voucher";

/** The subset of `expo-sqlite`'s database this needs. */
export interface SqlDb {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: (string | number | null)[]): Promise<unknown>;
  getAllAsync<T>(sql: string, ...params: (string | number | null)[]): Promise<T[]>;
  getFirstAsync<T>(sql: string, ...params: (string | number | null)[]): Promise<T | null>;
}

export interface Taken {
  entry: Entry;
  /** What was charged, in local minor units, when the till knows. */
  localMinor: bigint;
  currency: string;
}

export interface Conflict {
  id: string;
  a: Uint8Array;
  b: Uint8Array;
}

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS conflicts (
    id        TEXT PRIMARY KEY NOT NULL,
    a         TEXT NOT NULL,
    b         TEXT NOT NULL,
    reported  TEXT
  );
  CREATE TABLE IF NOT EXISTS vouchers (
    id           TEXT PRIMARY KEY NOT NULL,
    record       TEXT NOT NULL,
    local_minor  TEXT NOT NULL,
    currency     TEXT NOT NULL,
    booked       INTEGER NOT NULL DEFAULT 0
  );
`;

const CACHE_KEY = "enrolment-cache";

type Row = { record: string; local_minor: string; currency: string };
const toTaken = (r: Row): Taken => ({
  entry: fromRecord(JSON.parse(r.record) as EntryRecord),
  localMinor: BigInt(r.local_minor),
  currency: r.currency,
});

/** `open` is called once, on first use. */
export function voucherDb(open: () => Promise<SqlDb>) {
  let ready: Promise<SqlDb> | null = null;
  const db = () =>
    (ready ??= open().then(async (d) => {
      await d.execAsync(SCHEMA);
      return d;
    }));

  const queue: Store = {
    async all() {
      const rows = await (await db()).getAllAsync<{ record: string }>(`SELECT record FROM vouchers`);
      return rows.map((r) => fromRecord(JSON.parse(r.record) as EntryRecord));
    },
    async put(entry: Entry) {
      await (await db()).runAsync(`UPDATE vouchers SET record = ? WHERE id = ?`, JSON.stringify(toRecord(entry)), entry.id);
    },
  };

  return {
    queue,

    async loadCache(): Promise<EnrolmentCache> {
      const row = await (await db()).getFirstAsync<{ value: string }>(`SELECT value FROM kv WHERE key = ?`, CACHE_KEY);
      if (!row) return emptyCache();
      try {
        return cacheFromRecord(JSON.parse(row.value));
      } catch {
        // A cache that will not parse is rebuilt on the next sync, not a
        // reason for the phone to stop taking payments it can check.
        return emptyCache();
      }
    },

    async saveCache(cache: EnrolmentCache): Promise<void> {
      await (await db()).runAsync(
        `INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        CACHE_KEY,
        JSON.stringify(cacheToRecord(cache)),
      );
    },

    /** A voucher just taken. Taking the same one twice keeps the first. */
    async add(entry: Entry, localMinor: bigint, currency: string): Promise<void> {
      await (await db()).runAsync(
        `INSERT OR IGNORE INTO vouchers (id, record, local_minor, currency) VALUES (?, ?, ?, ?)`,
        entry.id,
        JSON.stringify(toRecord(entry)),
        localMinor.toString(),
        currency,
      );
    },

    /** Everything ever taken. */
    async taken(): Promise<Taken[]> {
      const rows = await (await db()).getAllAsync<Row>(`SELECT record, local_minor, currency FROM vouchers`);
      return rows.map(toTaken);
    },

    /** Settled and not yet written to a day-book. */
    async unbooked(): Promise<Taken[]> {
      const rows = await (await db()).getAllAsync<Row>(
        `SELECT record, local_minor, currency FROM vouchers WHERE booked = 0`,
      );
      return rows.map(toTaken).filter((t) => t.entry.status === "settled");
    },

    async markBooked(id: string): Promise<void> {
      await (await db()).runAsync(`UPDATE vouchers SET booked = 1 WHERE id = ?`, id);
    },

    /** Two different vouchers at one sequence. Kept until the relayer has it. */
    async addConflict(id: string, a: Uint8Array, b: Uint8Array): Promise<void> {
      await (await db()).runAsync(
        `INSERT OR IGNORE INTO conflicts (id, a, b) VALUES (?, ?, ?)`,
        id,
        encodeBase64(a),
        encodeBase64(b),
      );
    },

    async unreported(): Promise<Conflict[]> {
      const rows = await (await db()).getAllAsync<{ id: string; a: string; b: string }>(
        `SELECT id, a, b FROM conflicts WHERE reported IS NULL`,
      );
      return rows.map((r) => ({ id: r.id, a: decodeBase64(r.a), b: decodeBase64(r.b) }));
    },

    async markReported(id: string, outcome: string): Promise<void> {
      await (await db()).runAsync(`UPDATE conflicts SET reported = ? WHERE id = ?`, outcome, id);
    },
  };
}

export type VoucherDb = ReturnType<typeof voucherDb>;
