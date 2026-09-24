/**
 * Entries as plain JSON, for SQLite or anything else that does not store
 * bigints or bytes. The packet round-trips exactly: it is the evidence if a
 * redemption is ever disputed, and the input to `report_conflict`.
 */
import type { Verdict } from "./errors.ts";
import type { Attempt, Entry, Status } from "./queue.ts";

export interface EntryRecord {
  id: string;
  packetHex: string;
  vault: string;
  merchant: string;
  seq: string;
  amount: string;
  expiresAt: string;
  takenAt: number;
  status: Status;
  attempts: number;
  nextAttemptAt: number;
  inFlight: Attempt[];
  settledSignature: string | null;
  verdict: Verdict | null;
  awaitingOwnAttempts: boolean;
  updatedAt: number;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error("packet is not hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toRecord(e: Entry): EntryRecord {
  return {
    id: e.id,
    packetHex: toHex(e.packet),
    vault: e.vault,
    merchant: e.merchant,
    seq: e.seq.toString(),
    amount: e.amount.toString(),
    expiresAt: e.expiresAt.toString(),
    takenAt: e.takenAt,
    status: e.status,
    attempts: e.attempts,
    nextAttemptAt: e.nextAttemptAt,
    inFlight: e.inFlight.map((a) => ({ ...a })),
    settledSignature: e.settledSignature,
    verdict: e.verdict,
    awaitingOwnAttempts: e.awaitingOwnAttempts,
    updatedAt: e.updatedAt,
  };
}

export function fromRecord(r: EntryRecord): Entry {
  return {
    id: r.id,
    packet: fromHex(r.packetHex),
    vault: r.vault,
    merchant: r.merchant,
    seq: BigInt(r.seq),
    amount: BigInt(r.amount),
    expiresAt: BigInt(r.expiresAt),
    takenAt: r.takenAt,
    status: r.status,
    attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt,
    inFlight: r.inFlight.map((a) => ({ ...a })),
    settledSignature: r.settledSignature,
    verdict: r.verdict,
    awaitingOwnAttempts: r.awaitingOwnAttempts,
    updatedAt: r.updatedAt,
  };
}
