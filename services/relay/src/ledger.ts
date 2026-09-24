/**
 * What the relayer has submitted, and what it has spent. On disk, because the
 * relayer's memory is what keeps a merchant's retry from becoming a second
 * transaction.
 *
 * The merchant's till records a redemption's signature only after the relayer
 * answers. If the till crashes in between, it asks again, and the relayer must
 * answer with the *same* signature while that transaction can still land.
 * Building a second one would make the till read the first one's success as
 * "already redeemed", which it would report as fraud. This file is that memory.
 *
 * A JSON file, written atomically (temp file, fsync, rename). The relayer
 * handles one request at a time per process, and the file is small, so a
 * database would buy nothing.
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";

export interface Submission {
  /** Hex of the 105 signed bytes: the identity of the voucher. */
  message: string;
  /**
   * The whole voucher, base64. Kept because a *different* voucher at the same
   * sequence arriving later is half of a double-spend proof, and this is the
   * other half.
   */
  packet?: string;
  signature: string;
  lastValidBlockHeight: number;
  costLamports: number;
  createsAccount: boolean;
  submittedAt: number;
}

export interface ConflictReport {
  /** Both vouchers, base64: the proof, kept whatever happens on chain. */
  a: string;
  b: string;
  vault: string;
  signature: string | null;
  lastValidBlockHeight: number;
  reportedAt: number;
  /** Set once the vault's stake has been moved to the reserve. */
  slashSignature: string | null;
}

export interface LedgerState {
  /** `${vault}:${seq}` → the live submission for that voucher. */
  submissions: Record<string, Submission>;
  /** `${vault}:${seq}` → the double spend reported for it. */
  conflicts?: Record<string, ConflictReport>;
  /** Merchants whose token account the relayer has funded. Once each. */
  fundedMerchants: string[];
  /** UTC day, `YYYY-MM-DD`, that the spend below belongs to. */
  day: string;
  spentLamports: number;
  perVault: Record<string, number>;
}

export interface Ledger {
  read(): LedgerState;
  write(state: LedgerState): void;
}

export function emptyLedger(day: string): LedgerState {
  return { submissions: {}, conflicts: {}, fundedMerchants: [], day, spentLamports: 0, perVault: {} };
}

/** The day's spend resets at UTC midnight; everything else carries over. */
export function rollDay(state: LedgerState, day: string): LedgerState {
  return state.day === day ? state : { ...state, day, spentLamports: 0, perVault: {} };
}

export function utcDay(nowSeconds: number): string {
  return new Date(nowSeconds * 1000).toISOString().slice(0, 10);
}

export function memoryLedger(initial: LedgerState): Ledger & { state(): LedgerState } {
  let current = structuredClone(initial);
  return {
    read: () => structuredClone(current),
    write: (s) => void (current = structuredClone(s)),
    state: () => current,
  };
}

export function fileLedger(path: string, today: string): Ledger {
  return {
    read() {
      if (!existsSync(path)) return emptyLedger(today);
      return JSON.parse(readFileSync(path, "utf8")) as LedgerState;
    },
    write(state) {
      const tmp = `${path}.tmp`;
      const fd = openSync(tmp, "w");
      try {
        writeSync(fd, JSON.stringify(state, null, 2));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
    },
  };
}
