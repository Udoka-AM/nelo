/**
 * Storage for offline payments: the queue of vouchers taken and not yet paid,
 * and the cached list of payers they are checked against.
 *
 * Its own SQLite file, separate from the day-book. The day-book records money
 * that has arrived. This records money the merchant is *owed*, and mixing the
 * two in one table is how a till ends up showing takings it has not received.
 *
 * Writes resolve only once SQLite has them. `@nelo/queue` relies on that: it
 * stores a redemption's signature before the transaction is sent, so that a
 * crash cannot leave an attempt nobody knows about.
 */
import * as SQLite from "expo-sqlite";
import {
  emptyCache,
  fromRecord as cacheFromRecord,
  toRecord as cacheToRecord,
  type EnrolmentCache,
} from "@nelo/enrol";
import { fromRecord, toRecord, type Entry, type EntryRecord, type Store } from "@nelo/queue";

let db: SQLite.SQLiteDatabase | null = null;

async function handle(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;
  db = await SQLite.openDatabaseAsync("nelo-till.db");
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vouchers (
      id           TEXT PRIMARY KEY NOT NULL,
      record       TEXT NOT NULL,
      local_minor  TEXT NOT NULL,
      currency     TEXT NOT NULL,
      booked       INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

const CACHE_KEY = "enrolment-cache";

export async function loadCache(): Promise<EnrolmentCache> {
  const database = await handle();
  const row = await database.getFirstAsync<{ value: string }>(`SELECT value FROM kv WHERE key = ?`, CACHE_KEY);
  if (!row) return emptyCache();
  try {
    return cacheFromRecord(JSON.parse(row.value));
  } catch {
    // A cache that will not parse is a cache to rebuild on the next sync, not
    // a reason for the till to stop opening.
    return emptyCache();
  }
}

export async function saveCache(cache: EnrolmentCache): Promise<void> {
  const database = await handle();
  await database.runAsync(
    `INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    CACHE_KEY,
    JSON.stringify(cacheToRecord(cache)),
  );
}

/** The queue's view of the table. */
export const voucherStore: Store = {
  async all() {
    const database = await handle();
    const rows = await database.getAllAsync<{ record: string }>(`SELECT record FROM vouchers`);
    return rows.map((r) => fromRecord(JSON.parse(r.record) as EntryRecord));
  },
  async put(entry: Entry) {
    const database = await handle();
    await database.runAsync(`UPDATE vouchers SET record = ? WHERE id = ?`, JSON.stringify(toRecord(entry)), entry.id);
  },
};

/**
 * A voucher the merchant has just handed goods over for, with what they
 * charged in their own currency: that is what the day-book shows once it
 * settles.
 */
export async function addVoucher(entry: Entry, localMinor: bigint, currency: string): Promise<void> {
  const database = await handle();
  await database.runAsync(
    `INSERT OR IGNORE INTO vouchers (id, record, local_minor, currency) VALUES (?, ?, ?, ?)`,
    entry.id,
    JSON.stringify(toRecord(entry)),
    localMinor.toString(),
    currency,
  );
}

export interface Unbooked {
  entry: Entry;
  localMinor: bigint;
  currency: string;
}

/** Settled vouchers not yet written to the day-book. */
export async function unbooked(): Promise<Unbooked[]> {
  const database = await handle();
  const rows = await database.getAllAsync<{ record: string; local_minor: string; currency: string }>(
    `SELECT record, local_minor, currency FROM vouchers WHERE booked = 0`,
  );
  return rows
    .map((r) => ({
      entry: fromRecord(JSON.parse(r.record) as EntryRecord),
      localMinor: BigInt(r.local_minor),
      currency: r.currency,
    }))
    .filter((u) => u.entry.status === "settled");
}

export async function markBooked(id: string): Promise<void> {
  const database = await handle();
  await database.runAsync(`UPDATE vouchers SET booked = 1 WHERE id = ?`, id);
}
