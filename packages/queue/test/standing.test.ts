import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, standing, type Entry } from "../src/index.ts";
import { entry, onRedeem } from "./fixtures.ts";

const withStatus = (status: Entry["status"], verdict: Entry["verdict"] = null): Entry => ({
  ...entry(),
  status,
  verdict,
});

test("every status says whether the money is in, coming, lost, or needs a person", () => {
  assert.deepEqual(standing(withStatus("settled")), { state: "settled" });
  assert.deepEqual(standing(withStatus("pending")), { state: "owed", why: null });
  assert.equal(standing(withStatus("held", classify(onRedeem("MintMismatch")))).state, "held");
  assert.equal(standing(withStatus("expired")).state, "lost");
});

test("a pending payment that is blocked is still owed, with the reason it waits", () => {
  const s = standing(withStatus("pending", classify(onRedeem("InsufficientCollateral"))));
  assert.equal(s.state, "owed");
  if (s.state === "owed") assert.ok(s.why && s.why.length > 0);
});

test("a double spend is lost, in words a merchant can act on", () => {
  const s = standing(withStatus("refused", classify(onRedeem("SequenceAlreadyRedeemed"))));
  assert.deepEqual(s, { state: "lost", why: "The customer spent this money at another till first." });
});
