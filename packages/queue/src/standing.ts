/**
 * Where an offline payment stands, in the four words close of day uses.
 *
 * The queue has five statuses and a verdict because it needs to know what to
 * do next. A merchant counting up needs to know something simpler: is the
 * money in, still coming, lost, or does someone have to look?
 */
import type { Entry } from "./queue.ts";

export type Standing =
  /** In the merchant's account. */
  | { state: "settled" }
  /** Still coming: waiting for signal, a retry, or the chain. */
  | { state: "owed"; why: string | null }
  /** Stopped until a person looks. Not lost. */
  | { state: "held"; why: string }
  /** The goods went and the money will not come. */
  | { state: "lost"; why: string };

const LOST: Record<string, string> = {
  "paid-to-someone-else": "The customer spent this money at another till first.",
  expired: "It was not settled before it expired.",
  "sequence-too-old": "It reached the chain too late to settle.",
  "not-the-enrolled-key": "It was not signed by the customer's enrolled phone.",
  "unsupported-version": "The customer's app made a payment this version cannot settle.",
};

export function standing(e: Entry): Standing {
  switch (e.status) {
    case "settled":
      return { state: "settled" };
    case "pending":
      // A retryable verdict on a pending entry is why it is waiting.
      return { state: "owed", why: e.verdict?.detail ?? null };
    case "held":
      return { state: "held", why: e.verdict?.detail ?? "Held for a person to look at." };
    case "expired":
      return { state: "lost", why: LOST.expired! };
    case "refused": {
      const reason = e.verdict?.reason ?? "";
      return { state: "lost", why: LOST[reason] ?? e.verdict?.detail ?? "The chain refused it." };
    }
  }
}
