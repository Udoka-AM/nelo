/**
 * Where the issuer's state lives: SQLite, one row, written in a transaction.
 *
 * This is the most important write in the app. `@nelo/issue` saves the next
 * voucher's fixed bytes here *before* the secure element signs them, so a
 * crash cannot leave this phone able to sign one sequence over two messages.
 * `save` resolves only once SQLite has committed.
 *
 * The app is built with `allowBackup: false`. An Android backup restored onto
 * this or another phone would bring back an old counter, and signing from an
 * old counter is exactly the double-sign this file exists to prevent.
 */
import * as SQLite from "expo-sqlite";
import { fromRecord, toRecord, type IssuerState, type IssuerStore } from "@nelo/issue";

let db: SQLite.SQLiteDatabase | null = null;

async function handle(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;
  db = await SQLite.openDatabaseAsync("nelo-payer.db");
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS issuer (
      id    INTEGER PRIMARY KEY CHECK (id = 1),
      state TEXT NOT NULL
    );
  `);
  return db;
}

export const issuerStore: IssuerStore = {
  async load(): Promise<IssuerState | null> {
    const database = await handle();
    const row = await database.getFirstAsync<{ state: string }>(`SELECT state FROM issuer WHERE id = 1`);
    return row ? fromRecord(JSON.parse(row.state)) : null;
  },
  async save(state: IssuerState): Promise<void> {
    const database = await handle();
    await database.withTransactionAsync(async () => {
      await database.runAsync(
        `INSERT INTO issuer (id, state) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state`,
        JSON.stringify(toRecord(state)),
      );
    });
  },
};
