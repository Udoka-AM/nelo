/**
 * Where the day-book lives on the phone.
 *
 * SQLite rather than a JSON file: this is a ledger a merchant reconciles cash
 * against, it grows every day, and a half-written file after a battery pull is
 * not an acceptable outcome for a day's takings.
 *
 * Amounts are stored as TEXT. SQLite integers are 64-bit signed, which would
 * hold these fine today, but the values are bigint in every other layer and
 * round-tripping them through JS numbers is exactly how a ledger acquires a
 * rounding error nobody can explain later.
 */
import * as SQLite from "expo-sqlite";
import type { Sale } from "@nelo/ledger";

let db: SQLite.SQLiteDatabase | null = null;

async function handle(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;
  db = await SQLite.openDatabaseAsync("nelo-daybook.db");
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS sales (
      reference        TEXT PRIMARY KEY NOT NULL,
      signature        TEXT NOT NULL,
      local_minor      TEXT NOT NULL,
      currency         TEXT NOT NULL,
      amount_base      TEXT NOT NULL,
      mint             TEXT NOT NULL,
      at               INTEGER NOT NULL,
      overpaid         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sales_at ON sales (at DESC);
  `);
  return db;
}

interface Row {
  reference: string;
  signature: string;
  local_minor: string;
  currency: string;
  amount_base: string;
  mint: string;
  at: number;
  overpaid: number;
}

const toSale = (r: Row): Sale => ({
  reference: r.reference,
  signature: r.signature,
  localMinor: BigInt(r.local_minor),
  currency: r.currency,
  amountBaseUnits: BigInt(r.amount_base),
  mint: r.mint,
  at: r.at,
  overpaid: r.overpaid === 1,
});

/**
 * Record a settled sale. The reference is the primary key and `OR IGNORE` makes
 * this idempotent: a detection loop that fires twice, or a screen that remounts,
 * must not book the same takings twice.
 */
export async function record(sale: Sale): Promise<void> {
  const database = await handle();
  await database.runAsync(
    `INSERT OR IGNORE INTO sales
       (reference, signature, local_minor, currency, amount_base, mint, at, overpaid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    sale.reference,
    sale.signature,
    sale.localMinor.toString(),
    sale.currency,
    sale.amountBaseUnits.toString(),
    sale.mint,
    sale.at,
    sale.overpaid ? 1 : 0,
  );
}

/** Recent sales, newest first. Bounded — a day-book screen is not an export. */
export async function recent(limit = 500): Promise<Sale[]> {
  const database = await handle();
  const rows = await database.getAllAsync<Row>(
    `SELECT * FROM sales ORDER BY at DESC LIMIT ?`,
    limit,
  );
  return rows.map(toSale);
}
