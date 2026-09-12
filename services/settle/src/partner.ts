/**
 * The disbursement partner, behind one interface.
 *
 * This is the project's one hard external dependency: a licensed partner who
 * converts USDC and pays a merchant's own bank or mobile money. Yellow Card and
 * Onafriq are the two being chased. Neither may answer in time.
 *
 * So the interface comes first and the implementations come second, and one of
 * the implementations is a stub that says out loud that it is a stub. The fork
 * in docs/DELIVERABLES.md — "either stub the settlement leg and say so on
 * camera, or pivot the demo to merchant-to-merchant settlement" — is then a
 * choice of which object to construct, not a week of work.
 */
import type { ConversionRate } from "./money.ts";

/**
 * How much of this is real.
 *
 * Carried on every quote and every result, not just on the partner, because it
 * has to survive into the ledger memo and onto the "what actually ran" slide.
 * A stub that is indistinguishable from production at the call site is how a
 * demo ends up quietly claiming something untrue.
 */
export type Fidelity = "live" | "sandbox" | "stub";

export interface PayoutQuote {
  partner: string;
  fidelity: Fidelity;
  tokenCurrency: string;
  localCurrency: string;
  /** What the partner will give us. */
  partnerRate: ConversionRate;
  /** Unix ms after which this quote is no longer good. */
  expiresAt: number;
}

export interface DisburseRequest {
  payoutId: string;
  merchantId: string;
  /** Bank account or mobile-money number, as the partner expects it. */
  destination: string;
  tokenMinor: bigint;
  tokenCurrency: string;
  localMinor: bigint;
  localCurrency: string;
}

export type DisburseResult =
  | {
      status: "accepted";
      partner: string;
      fidelity: Fidelity;
      /** The partner's own reference. The idempotency key for settlement. */
      partnerReference: string;
    }
  | {
      status: "rejected";
      partner: string;
      fidelity: Fidelity;
      reason: string;
    };

export interface PayoutPartner {
  readonly name: string;
  readonly fidelity: Fidelity;
  quote(tokenCurrency: string, localCurrency: string, now: number): Promise<PayoutQuote>;
  disburse(request: DisburseRequest): Promise<DisburseResult>;
}

export interface StubOptions {
  /** The rate the stub pretends the partner gives. Illustrative, and labelled. */
  partnerRate: ConversionRate;
  localCurrency: string;
  /** Quote validity, in ms. Short on purpose — real quotes expire. */
  quoteTtlMs?: number;
  /**
   * Destinations the stub refuses, so the failure path is exercised by the
   * demo rather than assumed to work. A payout that cannot fail in testing
   * will fail for the first time in front of a merchant.
   */
  rejectDestinations?: readonly string[];
}

/**
 * The declared stub.
 *
 * It moves no money and it never pretends otherwise: `fidelity` is `"stub"` on
 * the partner, on every quote and on every result, and the reference it returns
 * is prefixed so it cannot be mistaken for a partner's own in a log, a ledger
 * memo or a screenshot.
 *
 * Deterministic, so a demo reproduces and a test does not flake.
 */
export class DeclaredStubPartner implements PayoutPartner {
  readonly name = "declared-stub";
  readonly fidelity: Fidelity = "stub";
  readonly #options: StubOptions;
  #counter = 0;

  constructor(options: StubOptions) {
    this.#options = options;
  }

  async quote(
    tokenCurrency: string,
    localCurrency: string,
    now: number,
  ): Promise<PayoutQuote> {
    if (localCurrency !== this.#options.localCurrency) {
      throw new Error(
        `the stub is configured for ${this.#options.localCurrency}, not ${localCurrency}`,
      );
    }
    return {
      partner: this.name,
      fidelity: this.fidelity,
      tokenCurrency,
      localCurrency,
      partnerRate: this.#options.partnerRate,
      expiresAt: now + (this.#options.quoteTtlMs ?? 60_000),
    };
  }

  async disburse(request: DisburseRequest): Promise<DisburseResult> {
    if (this.#options.rejectDestinations?.includes(request.destination)) {
      return {
        status: "rejected",
        partner: this.name,
        fidelity: this.fidelity,
        reason: `destination ${request.destination} refused by the stub`,
      };
    }
    this.#counter += 1;
    return {
      status: "accepted",
      partner: this.name,
      fidelity: this.fidelity,
      // Unmistakable on sight, in a log or a ledger memo.
      partnerReference: `STUB-${request.payoutId}-${this.#counter}`,
    };
  }
}

/**
 * Is this partner good enough to move a real merchant's money?
 *
 * Call it at the boundary in any environment that touches real funds. The stub
 * is for the demo and for tests; nothing should be able to reach production
 * with it wired in by accident.
 */
export function assertMovesRealMoney(partner: PayoutPartner): void {
  if (partner.fidelity !== "live") {
    throw new Error(
      `refusing to disburse real money through a ${partner.fidelity} partner (${partner.name})`,
    );
  }
}
