/**
 * Issuer state as plain JSON, for the phone's storage. Everything round-trips
 * exactly: the counter and the pending voucher are the two things whose loss
 * or corruption could make this phone sign one sequence twice.
 */
import type { ChainView, Fields, IssuerState, Outstanding } from "./issuer.ts";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => {
  if (s.length % 2 !== 0 || /[^0-9a-f]/i.test(s)) throw new Error("not hex");
  return Uint8Array.from({ length: s.length / 2 }, (_, i) => parseInt(s.slice(i * 2, i * 2 + 2), 16));
};

export interface IssuerRecord {
  vault: string;
  devicePubkey: string;
  nextSeq: string;
  chain: Record<keyof ChainView, string | number>;
  outstanding: Record<keyof Outstanding, string>[];
  pending: Record<keyof Fields, string | number> | null;
}

export function toRecord(s: IssuerState): IssuerRecord {
  const c = s.chain;
  const p = s.pending;
  return {
    vault: s.vault,
    devicePubkey: hex(s.devicePubkey),
    nextSeq: s.nextSeq.toString(),
    chain: {
      balance: c.balance.toString(),
      seqBase: c.seqBase.toString(),
      seqBitmap: c.seqBitmap.toString(),
      unlockAt: c.unlockAt.toString(),
      status: c.status,
      limit: c.limit.toString(),
      syncedAt: c.syncedAt,
    },
    outstanding: s.outstanding.map((o) => ({
      seq: o.seq.toString(),
      amount: o.amount.toString(),
      merchant: o.merchant,
      expiresAt: o.expiresAt.toString(),
    })),
    pending: p && {
      version: p.version,
      vault: hex(p.vault),
      seq: p.seq.toString(),
      amount: p.amount.toString(),
      remainingAfter: p.remainingAfter.toString(),
      merchant: hex(p.merchant),
      expiresAt: p.expiresAt.toString(),
      salt: hex(p.salt),
    },
  };
}

export function fromRecord(r: IssuerRecord): IssuerState {
  const c = r.chain;
  const p = r.pending;
  return {
    vault: r.vault,
    devicePubkey: unhex(r.devicePubkey),
    nextSeq: BigInt(r.nextSeq),
    chain: {
      balance: BigInt(c.balance),
      seqBase: BigInt(c.seqBase),
      seqBitmap: BigInt(c.seqBitmap),
      unlockAt: BigInt(c.unlockAt),
      status: Number(c.status),
      limit: BigInt(c.limit),
      syncedAt: Number(c.syncedAt),
    },
    outstanding: r.outstanding.map((o) => ({
      seq: BigInt(o.seq),
      amount: BigInt(o.amount),
      merchant: o.merchant,
      expiresAt: BigInt(o.expiresAt),
    })),
    pending: p && {
      version: Number(p.version),
      vault: unhex(String(p.vault)),
      seq: BigInt(p.seq),
      amount: BigInt(p.amount),
      remainingAfter: BigInt(p.remainingAfter),
      merchant: unhex(String(p.merchant)),
      expiresAt: BigInt(p.expiresAt),
      salt: unhex(String(p.salt)),
    },
  };
}
