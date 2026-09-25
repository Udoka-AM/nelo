/**
 * A merchant cashing out to their bank.
 *
 * Nelo never holds the merchant's money: offline sales settle into their own
 * wallet. So a cash-out is three steps, and this file keeps the record that
 * ties them together:
 *
 *   1. open an order with the partner, which answers with a deposit address;
 *   2. the merchant's wallet sends the USDC there (the relayer pays the fee);
 *   3. the partner pays the bank, and says so.
 *
 * ## One cash-out, one order, one transfer
 *
 * paj.cash takes no idempotency key: asked twice, it opens two orders. An
 * unfunded order costs nothing, so that is survivable. Sending the USDC twice
 * is not. So the app names each cash-out with an id it makes once, and the
 * record is written before the partner is asked and again, with the order and
 * its deposit address, before the app is told where to send anything. Asking
 * again returns the same order.
 *
 * ## Believe the partner's API, not its webhook
 *
 * A webhook is only a prompt to ask. Nothing documents a signature on
 * paj.cash's, so its body is never used: `refresh` reads the order's state
 * from the API, and the state only ever moves forward.
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import type { DisburseResult } from "./partner.ts";
import type { CashoutState, PartnerStatus } from "./paj/partner.ts";

export type State = "creating" | "funded" | CashoutState;

export interface Cashout {
  id: string;
  /** The merchant's wallet: where the USDC comes from. */
  merchant: string;
  /** Onboarding's canonical destination, `bank:NG:058:0123456789`. */
  destination: string;
  /** What the merchant asked to cash out, token base units. */
  tokenMinor: string;
  state: State;
  partner: string;
  reference: string | null;
  /** Where to send the tokens, and how many, as the partner asked. */
  deposit: string | null;
  fundMinor: string | null;
  /** What the bank account receives, local minor units. */
  localMinor: string | null;
  transferSignature: string | null;
  detail: string;
  createdAt: number;
  updatedAt: number;
}

export interface CashoutFile {
  cashouts: Record<string, Cashout>;
  /** `${merchant}:${YYYY-MM-DD}` → cash-outs opened that day. */
  opened: Record<string, number>;
}

export interface CashoutStore {
  read(): CashoutFile;
  write(file: CashoutFile): void;
}

export interface CashoutPartner {
  readonly name: string;
  disburse(request: {
    payoutId: string;
    merchantId: string;
    destination: string;
    tokenMinor: bigint;
    tokenCurrency: string;
    localMinor: bigint;
    localCurrency: string;
  }): Promise<DisburseResult>;
  status(reference: string): Promise<PartnerStatus>;
}

export interface CashoutDeps {
  store: CashoutStore;
  partner: CashoutPartner;
  /** Unix milliseconds. */
  now: number;
  tokenCurrency: string;
  localCurrency: string;
  limits: { perMerchantPerDay: number; minTokenMinor: bigint };
}

export type Opened = { ok: true; cashout: Cashout } | { ok: false; reason: string; retryable: boolean };

const ORDER: Record<State, number> = { creating: 0, "awaiting-funds": 1, funded: 2, processing: 3, paid: 4, failed: 4 };
const FINAL = new Set<State>(["paid", "failed"]);

export const emptyCashouts = (): CashoutFile => ({ cashouts: {}, opened: {} });

export async function openCashout(
  input: { id: string; merchant: string; destination: string; tokenMinor: bigint },
  deps: CashoutDeps,
): Promise<Opened> {
  const { store, partner, now } = deps;
  if (!/^[\w-]{8,64}$/.test(input.id)) return { ok: false, reason: "a cash-out id is 8 to 64 letters, digits, - or _", retryable: false };
  if (input.tokenMinor < deps.limits.minTokenMinor) return { ok: false, reason: "below the smallest cash-out", retryable: false };

  let file = store.read();
  const existing = file.cashouts[input.id];
  if (existing) {
    if (existing.merchant !== input.merchant || existing.destination !== input.destination || existing.tokenMinor !== input.tokenMinor.toString()) {
      return { ok: false, reason: "this cash-out id was used for a different cash-out", retryable: false };
    }
    // Opened, or failed for good: the same answer as before.
    if (existing.state !== "creating") return { ok: true, cashout: existing };
    // "creating": the partner may or may not have opened an order before a
    // crash. Asking again opens at most one more, unfunded, which is harmless.
  } else {
    const dayKey = `${input.merchant}:${new Date(now).toISOString().slice(0, 10)}`;
    if ((file.opened[dayKey] ?? 0) >= deps.limits.perMerchantPerDay) {
      return { ok: false, reason: "that is today's limit on cash-outs", retryable: true };
    }
    file = {
      cashouts: {
        ...file.cashouts,
        [input.id]: {
          id: input.id,
          merchant: input.merchant,
          destination: input.destination,
          tokenMinor: input.tokenMinor.toString(),
          state: "creating",
          partner: partner.name,
          reference: null,
          deposit: null,
          fundMinor: null,
          localMinor: null,
          transferSignature: null,
          detail: "opening an order",
          createdAt: now,
          updatedAt: now,
        },
      },
      opened: { ...file.opened, [dayKey]: (file.opened[dayKey] ?? 0) + 1 },
    };
    store.write(file); // before the partner is asked
  }

  const result = await partner.disburse({
    payoutId: input.id,
    merchantId: input.merchant,
    destination: input.destination,
    tokenMinor: input.tokenMinor,
    tokenCurrency: deps.tokenCurrency,
    localMinor: 0n,
    localCurrency: deps.localCurrency,
  });

  file = store.read();
  const current = file.cashouts[input.id]!;
  let next: Cashout;
  if (result.status === "rejected") {
    next = { ...current, state: "failed", detail: result.reason, updatedAt: now };
  } else if (!result.funding) {
    next = { ...current, state: "failed", detail: `${partner.name} accepted but said nowhere to send the funds`, updatedAt: now };
  } else if (result.funding.tokenMinor < input.tokenMinor) {
    // Asked to send less than the merchant is cashing out would leave the
    // difference nowhere. Refuse to fund rather than guess what it means.
    next = {
      ...current,
      state: "failed",
      reference: result.partnerReference,
      detail: `${partner.name} asked for ${result.funding.tokenMinor}, less than the ${input.tokenMinor} being cashed out`,
      updatedAt: now,
    };
  } else {
    next = {
      ...current,
      state: "awaiting-funds",
      reference: result.partnerReference,
      deposit: result.funding.address,
      fundMinor: result.funding.tokenMinor.toString(),
      localMinor: result.funding.localMinor.toString(),
      detail: "send the USDC to the deposit address",
      updatedAt: now,
    };
  }
  store.write({ ...file, cashouts: { ...file.cashouts, [input.id]: next } });
  return { ok: true, cashout: next };
}

/** The merchant's wallet has sent the USDC; record the transfer's signature. */
export function markFunded(id: string, signature: string, deps: { store: CashoutStore; now: number }): Opened {
  const file = deps.store.read();
  const c = file.cashouts[id];
  if (!c) return { ok: false, reason: "no such cash-out", retryable: false };
  if (c.transferSignature) {
    return c.transferSignature === signature
      ? { ok: true, cashout: c }
      : { ok: false, reason: "this cash-out was already funded by another transfer", retryable: false };
  }
  if (c.state !== "awaiting-funds") return { ok: false, reason: `a cash-out that is ${c.state} cannot be funded`, retryable: false };
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) return { ok: false, reason: "not a transaction signature", retryable: false };
  const next: Cashout = { ...c, state: "funded", transferSignature: signature, detail: "USDC sent; waiting for the partner", updatedAt: deps.now };
  deps.store.write({ ...file, cashouts: { ...file.cashouts, [id]: next } });
  return { ok: true, cashout: next };
}

/** Ask the partner where it stands. The state never moves backwards. */
export async function refresh(id: string, deps: { store: CashoutStore; partner: CashoutPartner; now: number }): Promise<Cashout | null> {
  const c = deps.store.read().cashouts[id];
  if (!c) return null;
  if (FINAL.has(c.state) || !c.reference || c.state === "creating") return c;
  const status = await deps.partner.status(c.reference);
  const file = deps.store.read();
  const current = file.cashouts[id]!;
  let next: Cashout = { ...current, detail: status.detail, updatedAt: deps.now };
  if (status.state) {
    // paj.cash says INIT for an order it has not seen money for, and it will
    // until the transfer lands; that must not undo "funded".
    if (ORDER[status.state] > ORDER[current.state]) next = { ...next, state: status.state };
    if (status.state === "failed" && current.transferSignature) {
      next = { ...next, detail: `${status.detail}. The USDC was sent (${current.transferSignature}); ask paj.cash where it was returned.` };
    }
  }
  deps.store.write({ ...file, cashouts: { ...file.cashouts, [id]: next } });
  return next;
}

/** Find a cash-out by the partner's reference, for a webhook. */
export function byReference(store: CashoutStore, reference: string): Cashout | null {
  return Object.values(store.read().cashouts).find((c) => c.reference === reference) ?? null;
}

export function memoryCashouts(initial: CashoutFile = emptyCashouts()): CashoutStore & { file(): CashoutFile } {
  let current = structuredClone(initial);
  return { read: () => structuredClone(current), write: (f) => void (current = structuredClone(f)), file: () => current };
}

/** A JSON file, written atomically: temp file, fsync, rename. */
export function fileCashouts(path: string): CashoutStore {
  return {
    read: () => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as CashoutFile) : emptyCashouts()),
    write(file) {
      const tmp = `${path}.tmp`;
      const fd = openSync(tmp, "w", 0o600);
      try {
        writeSync(fd, JSON.stringify(file, null, 2));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
    },
  };
}
