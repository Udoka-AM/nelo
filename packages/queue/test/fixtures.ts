/** Shared by the queue and settle tests. Not a test file itself. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encode } from "@nelo/voucher";
import { enqueue, type Entry } from "../src/index.ts";

export const CODES: Record<string, number> = JSON.parse(
  readFileSync(new URL("../vectors/program-errors-v1.json", import.meta.url), "utf8"),
);
export const onRedeem = (name: string) => ({ InstructionError: [1, { Custom: CODES[name]! }] });

export const T0 = 1_789_000_000_000; // ms
export const EXPIRES = BigInt(T0 / 1000 + 3600);

export function packet(o: { seq?: bigint; vault?: number; amount?: bigint; expiresAt?: bigint; salt?: number } = {}) {
  return encode({
    version: 1,
    vault: new Uint8Array(32).fill(o.vault ?? 0x11),
    seq: o.seq ?? 1n,
    amount: o.amount ?? 5_000_000n,
    remainingAfter: 0n,
    merchant: new Uint8Array(32).fill(0x22),
    expiresAt: o.expiresAt ?? EXPIRES,
    salt: new Uint8Array(8).fill(o.salt ?? 0),
    signature: new Uint8Array(64).fill(1),
    devicePubkey: new Uint8Array(33).fill(2),
  });
}

export function entry(o: Parameters<typeof packet>[0] = {}, now = T0): Entry {
  const r = enqueue(() => undefined, packet(o), now);
  assert.equal(r.kind, "added");
  return (r as { entry: Entry }).entry;
}
