/**
 * Merchant onboarding, as a state machine with no I/O.
 *
 * Step 2's done-when is *"a merchant completes setup without ever seeing a
 * key"*. The mechanism is Privy: an SMS code proves the phone, and an embedded
 * Solana wallet is created behind it. None of that can run here — it needs an
 * app ID, a development build and a handset.
 *
 * What *can* run here is the part that decides what happens next: which step
 * the merchant is on, whether what they typed is acceptable, whether a tap is
 * allowed yet, and what a failure means. So that lives here, as a total
 * function over an explicit state, and the hook in `apps/merchant/src/privy.ts`
 * is reduced to calling Privy and reporting back.
 *
 * Same reasoning as the rest of this package, and the same payoff: the flow a
 * merchant walks through is covered by tests that need neither.
 *
 * ## The shape of it
 *
 * `reduce(state, event, now)` returns the next state and, optionally, **one
 * effect** for the caller to perform. The reducer never performs an effect
 * itself and never reads the clock — `now` is passed in, as in `@nelo/ledger`,
 * so a cooldown is deterministic under test.
 *
 * ## The invariant that does the most work
 *
 * **A result is only accepted while the effect that produces it is in flight,
 * and only in the step that could have asked for it.** `code-sent`,
 * `logged-in` and `wallet-ready` each require `busy` *and* a matching step. A
 * promise that resolves late — a second tap, a remount, a retried send — then
 * cannot advance the flow twice, which here would mean creating a second wallet
 * or skipping the payout step entirely.
 *
 * `busy` alone is not enough, and the difference is not hypothetical: an effect
 * that starts the next effect leaves `busy` set across the handover, so a
 * duplicate `logged-in` would sail through a `busy`-only guard and create a
 * second wallet.
 */
import { normalisePhone, type Market } from "./phone.ts";
import {
  toCanonical,
  validateBankAccount,
  validateMobileMoney,
  type PayoutDestination,
  type PayoutResult,
} from "./payout.ts";

export type Step = "market" | "phone" | "code" | "wallet" | "payout" | "done";

/**
 * Who can actually do something about a message.
 *
 * This distinction is the difference between an onboarding that can be
 * debugged and one that cannot. "That code is not right" is the merchant's to
 * fix, standing at the counter. "SMS login is not enabled for this Privy app"
 * is nobody-at-the-counter's problem — it is a dashboard setting, and showing
 * it as though the merchant mistyped something sends them round the loop
 * forever.
 */
export type Audience = "merchant" | "operator";

export interface Notice {
  audience: Audience;
  message: string;
}

export interface FlowState {
  step: Step;
  /** Required, and never inferred from the number — the markets overlap. */
  market: Market | null;
  e164: string | null;
  /** The embedded wallet's address, once Privy has one. base58. */
  address: string | null;
  destination: PayoutDestination | null;
  /** The form `DisburseRequest.destination` takes, once there is one. */
  canonical: string | null;
  /** An effect is in flight. Input is refused rather than queued. */
  busy: boolean;
  notice: Notice | null;
  /** Non-fatal remarks about what was accepted — a check-digit mismatch. */
  warnings: string[];
  /** Epoch ms before which another code cannot be requested. */
  resendAfter: number | null;
}

/** The one thing the caller may do next. */
export type Effect =
  | { kind: "send-code"; e164: string }
  | { kind: "submit-code"; code: string }
  | { kind: "create-wallet" };

export type Event =
  | { type: "choose-market"; market: Market }
  | { type: "submit-phone"; input: string }
  | { type: "code-sent" }
  | { type: "submit-code"; input: string }
  | { type: "resend" }
  | { type: "logged-in" }
  /** Privy already holds a session for this install — the SMS steps are moot. */
  | { type: "already-logged-in" }
  | { type: "wallet-ready"; address: string }
  /** Ask again after a failed creation. The only retry with nothing to retype. */
  | { type: "retry-wallet" }
  | { type: "submit-bank"; institution: string; account: string }
  | { type: "submit-mobile-money"; phone: string }
  | { type: "failed"; error: unknown }
  | { type: "back" };

export interface Transition {
  state: FlowState;
  effect?: Effect;
}

/**
 * Privy rate-limits code requests, and a merchant who sees nothing arrive taps
 * again immediately. Refusing locally costs nothing; being refused by the API
 * spends the attempt and reads as a failure.
 */
export const RESEND_COOLDOWN_MS = 30_000;

/** Privy sends a six-digit OTP. */
const CODE_LENGTH = 6;
const CODE_PATTERN = new RegExp(`^\\d{${CODE_LENGTH}}$`);

export function initialState(): FlowState {
  return {
    step: "market",
    market: null,
    e164: null,
    address: null,
    destination: null,
    canonical: null,
    busy: false,
    notice: null,
    warnings: [],
    resendAfter: null,
  };
}

const merchantSays = (message: string): Notice => ({ audience: "merchant", message });
const operatorSays = (message: string): Notice => ({ audience: "operator", message });

/** No transition, no effect. An event that does not apply to this step. */
const stay = (state: FlowState): Transition => ({ state });

export function reduce(state: FlowState, event: Event, now: number): Transition {
  switch (event.type) {
    case "choose-market": {
      if (state.step !== "market") return stay(state);
      // Switching market discards the number. `0917…` is a real prefix in both
      // NG and PH, so the same digits are a different person — carrying them
      // across would silently onboard the wrong one.
      const changed = state.market !== event.market;
      return {
        state: {
          ...state,
          step: "phone",
          market: event.market,
          e164: changed ? null : state.e164,
          notice: null,
        },
      };
    }

    case "submit-phone": {
      if (state.step !== "phone" || state.busy || state.market === null) return stay(state);
      const result = normalisePhone(event.input, state.market);
      if (!result.ok) {
        return { state: { ...state, notice: merchantSays(result.reason) } };
      }
      return {
        state: { ...state, e164: result.e164, busy: true, notice: null },
        effect: { kind: "send-code", e164: result.e164 },
      };
    }

    case "code-sent": {
      // Only while a send is in flight, and only in a step that could have
      // asked for one: `phone` on the first send, `code` on a resend.
      if (!state.busy || (state.step !== "phone" && state.step !== "code")) return stay(state);
      return {
        state: {
          ...state,
          step: "code",
          busy: false,
          notice: null,
          resendAfter: now + RESEND_COOLDOWN_MS,
        },
      };
    }

    case "submit-code": {
      if (state.step !== "code" || state.busy) return stay(state);
      const code = event.input.replace(/[\s-]/g, "");
      if (!CODE_PATTERN.test(code)) {
        return {
          state: {
            ...state,
            notice: merchantSays(`The code is ${CODE_LENGTH} digits — check the message`),
          },
        };
      }
      return {
        state: { ...state, busy: true, notice: null },
        effect: { kind: "submit-code", code },
      };
    }

    case "resend": {
      if (state.step !== "code" || state.busy || state.e164 === null) return stay(state);
      if (state.resendAfter !== null && now < state.resendAfter) {
        const seconds = Math.ceil((state.resendAfter - now) / 1000);
        return {
          state: { ...state, notice: merchantSays(`Wait ${seconds}s for the code to arrive`) },
        };
      }
      return {
        state: { ...state, busy: true, notice: null },
        effect: { kind: "send-code", e164: state.e164 },
      };
    }

    case "logged-in": {
      // `code` is the only step that submits one, so a second arrival — at
      // `wallet`, while the create is itself in flight — issues no second
      // create. Checking `busy` alone would not catch that, because the create
      // keeps it set.
      if (!state.busy || state.step !== "code") return stay(state);
      // The merchant is never asked whether they want a wallet. That question
      // is the thing step 2 exists to remove.
      return {
        state: { ...state, step: "wallet", busy: true, notice: null },
        effect: { kind: "create-wallet" },
      };
    }

    case "already-logged-in": {
      // Only from the two steps a live session makes redundant, and only while
      // idle. The caller raises this from an effect watching Privy's `user`,
      // which also becomes non-null a moment after a *successful* login — so
      // accepting it at `wallet` would create a second wallet on the ordinary
      // happy path.
      //
      // The market check is the same one as everywhere else: the payout step's
      // rules are per-market, so arriving there without one is unanswerable.
      if (state.market === null || state.busy) return stay(state);
      if (state.step !== "phone" && state.step !== "code") return stay(state);
      return {
        state: { ...state, step: "wallet", busy: true, notice: null },
        effect: { kind: "create-wallet" },
      };
    }

    case "retry-wallet": {
      if (state.step !== "wallet" || state.busy) return stay(state);
      return {
        state: { ...state, busy: true, notice: null },
        effect: { kind: "create-wallet" },
      };
    }

    case "wallet-ready": {
      if (!state.busy || state.step !== "wallet") return stay(state);
      return {
        state: { ...state, step: "payout", busy: false, address: event.address, notice: null },
      };
    }

    case "submit-bank": {
      if (state.step !== "payout" || state.busy || state.market === null) return stay(state);
      return settle(state, validateBankAccount(state.market, event.institution, event.account));
    }

    case "submit-mobile-money": {
      if (state.step !== "payout" || state.busy || state.market === null) return stay(state);
      return settle(state, validateMobileMoney(state.market, event.phone));
    }

    case "failed": {
      // The step deliberately does not move. Whatever failed, the merchant is
      // still where they were, and the thing they were doing can be retried.
      return { state: { ...state, busy: false, notice: explain(event.error) } };
    }

    case "back": {
      if (state.busy) return stay(state);
      if (state.step === "code") return { state: { ...state, step: "phone", notice: null } };
      if (state.step === "phone") return { state: { ...state, step: "market", notice: null } };
      // From `wallet` onwards there is nothing to go back to: the wallet
      // exists, and an account that exists cannot be un-created by a button.
      return stay(state);
    }
  }
}

function settle(state: FlowState, result: PayoutResult): Transition {
  if (!result.ok) {
    return { state: { ...state, notice: merchantSays(result.reason) } };
  }
  return {
    state: {
      ...state,
      step: "done",
      destination: result.destination,
      canonical: toCanonical(result.destination),
      warnings: result.warnings,
      notice: null,
    },
  };
}

// ------------------------------------------------------- what went wrong ---

/**
 * Turn a Privy failure into something someone can act on.
 *
 * The codes are Privy's own, read off `PrivyApiError.code` and
 * `PrivyClientError.code`. Anything unrecognised is **passed through rather
 * than replaced**: a generic "something went wrong" on a first development
 * build is how a configuration problem stays invisible for an afternoon.
 */
export function explain(error: unknown): Notice {
  const code = codeOf(error);

  if (code !== null) {
    const merchant = MERCHANT_MESSAGES[code];
    if (merchant) return merchantSays(merchant);
    const operator = OPERATOR_MESSAGES[code];
    if (operator) return operatorSays(operator);
  }

  const detail = messageOf(error);
  return operatorSays(
    code === null
      ? `Onboarding failed: ${detail}`
      : `Onboarding failed (${code}): ${detail}`,
  );
}

/** Things the person holding the phone can fix. */
const MERCHANT_MESSAGES: Record<string, string> = {
  invalid_credentials: "That code is not right. Check the message and type it again.",
  too_many_requests: "Too many tries. Wait a minute, then ask for a new code.",
  invalid_data: "That number was refused. Check it and try again.",
  user_unsubscribed:
    "That number has opted out of our messages, so a code cannot reach it. Use another number.",
  device_revoked:
    "This phone was removed from the account. Set it up again from the phone that still has access.",
};

/**
 * Things only whoever configured the app can fix. Every one of these is a
 * dashboard setting or a build setting, not a mistake at the counter.
 */
const OPERATOR_MESSAGES: Record<string, string> = {
  missing_or_invalid_privy_app_id:
    "Privy rejected the app ID. Check EXPO_PUBLIC_PRIVY_APP_ID against the dashboard.",
  missing_or_invalid_privy_client_id:
    "Privy rejected the client ID. Check it against the app's clients in the dashboard.",
  invalid_native_app_id:
    "Privy does not recognise this build's Android application ID. Add it to the app's allowed app identifiers.",
  disallowed_login_method: "SMS login is not enabled for this Privy app.",
  // Filed here after it fired for real, on a Nigerian number, against an app
  // whose dashboard simply had not enabled SMS for that country. It used to sit
  // in the merchant table as "try another mobile number" — advice that cannot
  // work when every number in the country is refused, and that lands on the
  // merchant as though they had mistyped their own phone.
  //
  // It can also mean a non-mobile line, which a merchant *could* fix. But they
  // cannot tell the two apart from the outside, and only one of them is worth
  // sending someone to find a second SIM for. So the message names both and the
  // audience is whoever can actually check.
  not_supported:
    "Privy will not send a code to that destination. Check the app's enabled SMS countries first; it can also mean the number is not a mobile line.",
  allowlist_rejected: "This Privy app has an allowlist and the number is not on it.",
  max_accounts_reached: "This Privy app has reached its user limit.",
  feature_not_enabled: "Embedded Solana wallets are not enabled for this Privy app.",
  invalid_origin: "Privy refused the request origin. Check the app's allowed origins.",
  attempted_submit_otp_before_sending:
    "A code was submitted before one was sent — a sequencing bug in the app, not a merchant error.",
  embedded_wallet_before_logged_in:
    "The wallet was asked for before the login completed — a sequencing bug in the app.",
  embedded_wallet_creation_error: "Privy could not create the embedded wallet.",
  embedded_wallet_already_exists:
    "This user already has an embedded Solana wallet — use the existing one rather than creating another.",
  embedded_wallet_needs_recovery:
    "The embedded wallet needs recovery before it can be used on this device.",
};

function codeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? code : null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "no detail given";
}
