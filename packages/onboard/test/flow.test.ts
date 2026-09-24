/**
 * The onboarding flow. Everything here is the part of the Privy wiring that
 * does not need Privy: which step the merchant is on, what is accepted, what a
 * tap is allowed to do, and who a failure is addressed to.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  explain,
  initialState,
  reduce,
  RESEND_COOLDOWN_MS,
  type Effect,
  type Event,
  type FlowState,
} from "../src/flow.ts";
import { nubanCheckDigit } from "../src/payout.ts";

const T0 = 1_700_000_000_000;

/** Apply a run of events, collecting the effects they asked for. */
function walk(events: Event[], from: FlowState = initialState(), now = T0) {
  let state = from;
  const effects: Effect[] = [];
  for (const event of events) {
    const next = reduce(state, event, now);
    state = next.state;
    if (next.effect) effects.push(next.effect);
  }
  return { state, effects };
}

const one = (state: FlowState, event: Event, now = T0) => reduce(state, event, now);

/** The events that get a merchant from nothing to the payout step. */
const toPayout = (market: "NG" | "PH", typed: string, address: string): Event[] => [
  { type: "choose-market", market },
  { type: "submit-phone", input: typed },
  { type: "code-sent" },
  { type: "submit-code", input: "123456" },
  { type: "logged-in" },
  { type: "wallet-ready", address },
];

const ADDRESS = "7XSvJnS19TodrQJSbjUR3NLSZoK3mHvfDXbGvJDPBbxs";

// --------------------------------------------------------- the happy path ---

test("a Nigerian merchant with a bank account reaches done, and carries what settle needs", () => {
  const { state, effects } = walk([
    ...toPayout("NG", "0803 123 4567", ADDRESS),
    { type: "submit-bank", institution: "058", account: "0123456789" },
  ]);

  assert.equal(state.step, "done");
  assert.equal(state.market, "NG");
  assert.equal(state.e164, "+2348031234567");
  assert.equal(state.address, ADDRESS);
  assert.equal(state.canonical, "bank:NG:058:0123456789");
  assert.equal(state.busy, false);
  assert.equal(state.notice, null);

  // One effect per step that needs the network, in order, and no more.
  assert.deepEqual(effects, [
    { kind: "send-code", e164: "+2348031234567" },
    { kind: "submit-code", code: "123456" },
    { kind: "create-wallet" },
  ]);
});

test("a Philippine merchant paid by mobile money reaches done", () => {
  const { state } = walk([
    ...toPayout("PH", "0917 123 4567", ADDRESS),
    { type: "submit-mobile-money", phone: "09171234567" },
  ]);

  assert.equal(state.step, "done");
  assert.equal(state.canonical, "momo:PH:+639171234567");
});

/**
 * The payout step's rules are per-market, so a flow that arrives there without
 * one cannot be answered. Asserted as a property of every path to it rather
 * than trusted to the ordering of the steps.
 */
test("market is never null once the payout step is reachable", () => {
  for (const events of [
    toPayout("NG", "08031234567", ADDRESS),
    toPayout("PH", "09171234567", ADDRESS),
    [
      { type: "choose-market", market: "NG" } as Event,
      { type: "already-logged-in" } as Event,
      { type: "wallet-ready", address: ADDRESS } as Event,
    ],
  ]) {
    const { state } = walk(events);
    assert.equal(state.step, "payout");
    assert.notEqual(state.market, null);
  }
});

// -------------------------------------------------------- the phone step ---

test("nothing can be typed before a market is chosen", () => {
  const { state, effects } = walk([{ type: "submit-phone", input: "08031234567" }]);
  assert.equal(state.step, "market");
  assert.deepEqual(effects, []);
});

test("a refused number keeps the merchant on the step and says why", () => {
  const { state, effects } = walk([
    { type: "choose-market", market: "NG" },
    { type: "submit-phone", input: "0803123456" }, // one digit short
  ]);

  assert.equal(state.step, "phone");
  assert.equal(state.busy, false);
  assert.equal(state.notice?.audience, "merchant");
  assert.deepEqual(effects, [], "nothing should be sent for a number we already know is wrong");
});

test("the code is sent to the normalised number, not to what was typed", () => {
  const { effects } = walk([
    { type: "choose-market", market: "NG" },
    { type: "submit-phone", input: "+234 (803) 123-4567" },
  ]);
  assert.deepEqual(effects, [{ kind: "send-code", e164: "+2348031234567" }]);
});

/**
 * The overlap finding, as a transition. `0917…` is a real prefix in both
 * markets, so a number carried across a market change would onboard a
 * different person with the same digits.
 */
test("switching market discards the number", () => {
  const sent = walk([
    { type: "choose-market", market: "NG" },
    { type: "submit-phone", input: "09171234567" },
    { type: "code-sent" },
  ]).state;
  assert.equal(sent.e164, "+2349171234567");

  const back = walk([{ type: "back" }, { type: "back" }], sent).state;
  assert.equal(back.step, "market");

  const switched = one(back, { type: "choose-market", market: "PH" }).state;
  assert.equal(switched.e164, null, "the NG number must not survive into PH");
  assert.equal(switched.market, "PH");
});

test("re-choosing the same market keeps the number that was already accepted", () => {
  const sent = walk([
    { type: "choose-market", market: "NG" },
    { type: "submit-phone", input: "08031234567" },
    { type: "code-sent" },
    { type: "back" },
    { type: "back" },
  ]).state;
  const again = one(sent, { type: "choose-market", market: "NG" }).state;
  assert.equal(again.e164, "+2348031234567");
});

// --------------------------------------------------------- the code step ---

const atCode = () =>
  walk([
    { type: "choose-market", market: "NG" },
    { type: "submit-phone", input: "08031234567" },
    { type: "code-sent" },
  ]).state;

test("a code typed in groups is accepted", () => {
  const { effect } = one(atCode(), { type: "submit-code", input: "12 34-56" });
  assert.deepEqual(effect, { kind: "submit-code", code: "123456" });
});

test("a code of the wrong shape is refused locally, naming the length", () => {
  for (const input of ["1234", "1234567", "12345a", ""]) {
    const { state, effect } = one(atCode(), { type: "submit-code", input });
    assert.equal(state.step, "code", input);
    assert.equal(effect, undefined, `"${input}" should not reach Privy`);
    assert.match(state.notice?.message ?? "", /6 digits/);
  }
});

/**
 * Privy has a client error for exactly this — `attempted_submit_otp_before_sending`.
 * The guard makes it unreachable rather than merely handled.
 */
test("a code cannot be submitted before one has been sent", () => {
  const onPhone = one(initialState(), { type: "choose-market", market: "NG" }).state;
  const { state, effect } = one(onPhone, { type: "submit-code", input: "123456" });
  assert.equal(state.step, "phone");
  assert.equal(effect, undefined);
});

test("a resend inside the cooldown is refused, and says how long is left", () => {
  const state = atCode();
  const { state: refused, effect } = one(state, { type: "resend" }, T0 + 10_000);
  assert.equal(effect, undefined);
  assert.equal(refused.busy, false);
  assert.match(refused.notice?.message ?? "", /20s/);
});

test("a resend after the cooldown asks for a new code for the same number", () => {
  const state = atCode();
  const { effect } = one(state, { type: "resend" }, T0 + RESEND_COOLDOWN_MS);
  assert.deepEqual(effect, { kind: "send-code", e164: "+2348031234567" });
});

// ------------------------------------------- results only land once, ever ---

/**
 * The invariant the whole machine leans on. A result is accepted only while the
 * effect producing it is in flight, so a late promise, a remount or a second
 * tap cannot advance the flow a second time.
 */
test("a late code-sent does not restart the cooldown", () => {
  const state = atCode();
  assert.equal(state.resendAfter, T0 + RESEND_COOLDOWN_MS);
  const late = one(state, { type: "code-sent" }, T0 + 60_000).state;
  assert.equal(late.resendAfter, T0 + RESEND_COOLDOWN_MS, "the clock must not be pushed forward");
});

/**
 * The second arrival happens while the create it started is still in flight, so
 * `busy` is *set* — which is why the guard cannot be `busy` alone. Creating a
 * second wallet is the one failure here with no undo: the merchant ends up with
 * an address the day-book does not know about.
 */
test("logging in twice creates one wallet, not two", () => {
  const submitted = walk([{ type: "submit-code", input: "123456" }], atCode()).state;
  const first = one(submitted, { type: "logged-in" });
  assert.deepEqual(first.effect, { kind: "create-wallet" });
  assert.equal(first.state.step, "wallet");
  assert.equal(first.state.busy, true, "the create is in flight");

  const second = one(first.state, { type: "logged-in" });
  assert.equal(second.effect, undefined, "no second wallet");
  assert.deepEqual(second.state, first.state);
});

test("a resend's code-sent keeps the merchant on the code step", () => {
  const resent = one(atCode(), { type: "resend" }, T0 + RESEND_COOLDOWN_MS).state;
  assert.equal(resent.busy, true);
  const landed = one(resent, { type: "code-sent" }, T0 + RESEND_COOLDOWN_MS).state;
  assert.equal(landed.step, "code");
  assert.equal(landed.busy, false);
  assert.equal(
    landed.resendAfter,
    T0 + 2 * RESEND_COOLDOWN_MS,
    "a fresh code starts a fresh cooldown",
  );
});

test("a wallet address arriving unbidden is ignored", () => {
  const { state, effect } = one(atCode(), { type: "wallet-ready", address: ADDRESS });
  assert.equal(state.step, "code");
  assert.equal(state.address, null);
  assert.equal(effect, undefined);
});

test("a double tap sends one code", () => {
  const onPhone = one(initialState(), { type: "choose-market", market: "NG" }).state;
  const first = one(onPhone, { type: "submit-phone", input: "08031234567" });
  assert.notEqual(first.effect, undefined);
  const second = one(first.state, { type: "submit-phone", input: "08031234567" });
  assert.equal(second.effect, undefined, "the second tap must not send a second SMS");
});

// ---------------------------------------------------------------- going back ---

test("back walks the steps that can be walked, and stops where it cannot", () => {
  const code = atCode();
  const phone = one(code, { type: "back" }).state;
  assert.equal(phone.step, "phone");
  assert.equal(phone.e164, "+2348031234567", "the field should still be filled in");

  const market = one(phone, { type: "back" }).state;
  assert.equal(market.step, "market");

  // A wallet that exists cannot be un-created by a button.
  const payout = walk(toPayout("NG", "08031234567", ADDRESS)).state;
  assert.equal(one(payout, { type: "back" }).state.step, "payout");
});

test("back does nothing while something is in flight", () => {
  const busy = walk([{ type: "submit-code", input: "123456" }], atCode()).state;
  assert.equal(busy.busy, true);
  assert.equal(one(busy, { type: "back" }).state.step, "code");
});

test("a failed wallet creation can be retried without retyping anything", () => {
  const failed = walk(
    [
      { type: "submit-code", input: "123456" },
      { type: "logged-in" },
      { type: "failed", error: { code: "embedded_wallet_creation_error" } },
    ],
    atCode(),
  ).state;
  assert.equal(failed.step, "wallet");
  assert.equal(failed.notice?.audience, "operator");

  const retry = one(failed, { type: "retry-wallet" });
  assert.deepEqual(retry.effect, { kind: "create-wallet" });
  assert.equal(retry.state.notice, null);

  // Not a second create while the first is still going, and not from any
  // other step.
  assert.equal(one(retry.state, { type: "retry-wallet" }).effect, undefined);
  assert.equal(one(atCode(), { type: "retry-wallet" }).effect, undefined);
});

// ------------------------------------------------------------- the payout ---

test("a check-digit mismatch reaches done, carrying the warning", () => {
  const serial = "012345678";
  const correct = nubanCheckDigit("058", serial);
  if (correct === null) throw new Error("fixture has no check digit");

  const { state } = walk([
    ...toPayout("NG", "08031234567", ADDRESS),
    { type: "submit-bank", institution: "058", account: `${serial}${(correct + 1) % 10}` },
  ]);

  assert.equal(state.step, "done", "an unverified check digit must never block onboarding");
  assert.equal(state.warnings.length, 1);
});

test("a payout account of the wrong shape keeps the merchant on the step", () => {
  const payout = walk(toPayout("NG", "08031234567", ADDRESS)).state;
  const { state } = one(payout, { type: "submit-bank", institution: "058", account: "12345" });
  assert.equal(state.step, "payout");
  assert.equal(state.canonical, null);
  assert.equal(state.notice?.audience, "merchant");
});

// ------------------------------------------------------------- failures ---

test("a failure clears the spinner and leaves the step alone, so it can be retried", () => {
  const submitted = walk([{ type: "submit-code", input: "123456" }], atCode()).state;
  const failed = one(submitted, {
    type: "failed",
    error: { code: "invalid_credentials", message: "wrong" },
  }).state;

  assert.equal(failed.step, "code");
  assert.equal(failed.busy, false);
  assert.equal(failed.notice?.audience, "merchant");

  // And the retry actually goes through.
  assert.notEqual(one(failed, { type: "submit-code", input: "654321" }).effect, undefined);
});

test("a wrong code is the merchant's to fix; a misconfigured app is not", () => {
  assert.equal(explain({ code: "invalid_credentials" }).audience, "merchant");
  assert.equal(explain({ code: "too_many_requests" }).audience, "merchant");

  // Was asserted as "merchant" until it fired on a real Nigerian number and the
  // cause turned out to be a dashboard setting. A merchant told to try another
  // number would have gone looking for a second SIM that would fail too.
  assert.equal(explain({ code: "not_supported" }).audience, "operator");

  assert.equal(explain({ code: "disallowed_login_method" }).audience, "operator");
  assert.equal(explain({ code: "invalid_native_app_id" }).audience, "operator");
  assert.equal(explain({ code: "missing_or_invalid_privy_app_id" }).audience, "operator");
  assert.equal(explain({ code: "feature_not_enabled" }).audience, "operator");
});

/**
 * An unrecognised failure must not be replaced by a reassuring sentence. On a
 * first development build the detail is the only thing that says what is wrong.
 */
test("an unknown failure keeps its detail", () => {
  const withCode = explain({ code: "some_new_privy_code", message: "the wire broke" });
  assert.equal(withCode.audience, "operator");
  assert.match(withCode.message, /some_new_privy_code/);

  const plain = explain(new Error("Network request failed"));
  assert.match(plain.message, /Network request failed/);

  // And nothing throws on the shapes a catch block can actually receive.
  for (const value of [undefined, null, "boom", 7, {}, []]) {
    assert.equal(typeof explain(value).message, "string");
  }
});

// -------------------------------------------------------------- hygiene ---

test("the reducer does not mutate the state it is given", () => {
  const before = atCode();
  const snapshot = structuredClone(before);
  one(before, { type: "submit-code", input: "123456" });
  one(before, { type: "resend" }, T0 + RESEND_COOLDOWN_MS);
  one(before, { type: "failed", error: new Error("x") });
  assert.deepEqual(before, snapshot);
});

/**
 * The hook raises this from an effect watching Privy's `user`, and `user`
 * becomes non-null a moment after an ordinary successful login too. If the
 * machine accepted it there, every happy path would create a second wallet.
 */
test("a live session noticed just after logging in does not create a second wallet", () => {
  const creating = walk(
    [{ type: "submit-code", input: "123456" }, { type: "logged-in" }],
    atCode(),
  ).state;
  assert.equal(creating.step, "wallet");

  const noticed = one(creating, { type: "already-logged-in" });
  assert.equal(noticed.effect, undefined);
  assert.deepEqual(noticed.state, creating);

  // Nor once the wallet is there and the merchant is entering a payout account.
  const payout = one(creating, { type: "wallet-ready", address: ADDRESS }).state;
  assert.equal(one(payout, { type: "already-logged-in" }).effect, undefined);
});

test("an already-live Privy session skips the SMS steps, but not the market", () => {
  const cold = one(initialState(), { type: "already-logged-in" });
  assert.equal(cold.state.step, "market", "without a market the payout step is unanswerable");
  assert.equal(cold.effect, undefined);

  const warm = walk([
    { type: "choose-market", market: "NG" },
    { type: "already-logged-in" },
  ]);
  assert.equal(warm.state.step, "wallet");
  assert.deepEqual(warm.effects, [{ kind: "create-wallet" }]);
});
