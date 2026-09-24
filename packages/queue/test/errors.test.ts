/**
 * Classification. The numbers are read from the vectors the program generates,
 * never typed here, so these tests say what each *named* error means and the
 * vectors say what number it has.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classify, PROGRAM_ERROR_CODES, type ProgramErrorName } from "../src/index.ts";

const VECTORS: Record<string, number> = JSON.parse(
  readFileSync(new URL("../vectors/program-errors-v1.json", import.meta.url), "utf8"),
);

const onRedeem = (name: ProgramErrorName) => ({ InstructionError: [1, { Custom: VECTORS[name]! }] });

test("the code table is exactly the program's", () => {
  assert.ok(Object.keys(VECTORS).length >= 33, "the vectors are not empty or truncated");
  assert.deepEqual({ ...PROGRAM_ERROR_CODES }, VECTORS);
});

test("already redeemed means somebody else was paid", () => {
  const v = classify(onRedeem("SequenceAlreadyRedeemed"));
  assert.equal(v.kind, "refused");
  if (v.kind === "refused") assert.equal(v.reason, "paid-to-someone-else");
});

test("what can never settle is refused", () => {
  const cases: [ProgramErrorName, string][] = [
    ["VoucherExpired", "expired"],
    ["SequenceTooOld", "sequence-too-old"],
    ["DeviceKeyMismatch", "not-the-enrolled-key"],
    ["BadVoucherVersion", "unsupported-version"],
  ];
  for (const [name, reason] of cases) {
    const v = classify(onRedeem(name));
    assert.equal(v.kind, "refused", name);
    assert.equal(v.reason, reason, name);
  }
});

test("what chain state can still change is blocked, not refused", () => {
  // Refusing these gives up on money: the limit moves with the stake price,
  // collateral can be topped up, and the window advances as earlier vouchers
  // settle.
  const cases: [ProgramErrorName, string][] = [
    ["AboveFloorLimit", "above-limit"],
    ["InsufficientCollateral", "collateral-short"],
    ["SequenceTooFarAhead", "sequence-ahead"],
  ];
  for (const [name, reason] of cases) {
    const v = classify(onRedeem(name));
    assert.equal(v.kind, "blocked", name);
    assert.equal(v.reason, reason, name);
  }
});

test("errors that mean the transaction was built wrong are held", () => {
  for (const name of [
    "VaultMismatch",
    "MerchantMismatch",
    "MintMismatch",
    "MissingPrecompileInstruction",
    "MalformedPrecompileInstruction",
    "ExpectedSingleSignature",
    "PrecompileDataNotSelfContained",
    "SignedMessageMismatch",
  ] as const) {
    const v = classify(onRedeem(name));
    assert.equal(v.kind, "held", name);
    assert.equal(v.reason, "misbuilt", name);
  }
});

test("program errors redeem_voucher never returns are held as unknown", () => {
  for (const name of ["Overflow", "NotRiskAuthority", "NothingToSlash", "VaultFrozen"] as const) {
    const v = classify(onRedeem(name));
    assert.equal(v.kind, "held", name);
    assert.equal(v.reason, "unknown", name);
  }
});

test("every program error is classified one way or another, none retried blind", () => {
  // Nothing from the program is ever "transient": a program error is an answer.
  for (const name of Object.keys(VECTORS) as ProgramErrorName[]) {
    assert.notEqual(classify(onRedeem(name)).kind, "transient", name);
  }
});

test("a code the program has never had is held, not guessed at", () => {
  const v = classify({ InstructionError: [1, { Custom: 6999 }] });
  assert.equal(v.kind, "held");
  assert.equal(v.reason, "unknown");
});

test("Anchor's own account errors mean the transaction was built wrong", () => {
  for (const code of [2006, 3012]) {
    const v = classify({ InstructionError: [1, { Custom: code }] });
    assert.equal(v.kind, "held");
    assert.equal(v.reason, "misbuilt");
  }
});

test("a failure in instruction 0 is the precompile, and is held", () => {
  const v = classify({ InstructionError: [0, { Custom: 2 }] });
  assert.equal(v.kind, "held");
  assert.equal(v.reason, "precompile-rejected");
  assert.equal(classify({ InstructionError: [0, "InvalidInstructionData"] }).reason, "precompile-rejected");
});

test("an error in any other instruction is not read as the program's", () => {
  const code = VECTORS.SequenceAlreadyRedeemed!;
  const v = classify({ InstructionError: [2, { Custom: code }] });
  assert.equal(v.kind, "held");
  assert.equal(v.reason, "unknown");
});

test("kit's bigint codes classify like numbers", () => {
  const big = classify({ InstructionError: [1n, { Custom: BigInt(VECTORS.SequenceAlreadyRedeemed!) }] });
  assert.deepEqual(big, classify(onRedeem("SequenceAlreadyRedeemed")));
});

test("transaction-level errors", () => {
  assert.equal(classify("BlockhashNotFound").kind, "transient");
  assert.equal(classify("AlreadyProcessed").kind, "check");
  const fee = classify("InsufficientFundsForFee");
  assert.equal(fee.kind, "blocked");
  assert.equal(fee.reason, "fee-payer-unfunded");
  assert.equal(classify("AccountNotFound").reason, "fee-payer-unfunded");
});

test("anything unrecognised is held, and says what it was", () => {
  for (const err of ["SomethingNew", null, undefined, 42, { Weird: true }]) {
    const v = classify(err);
    assert.equal(v.kind, "held", String(err));
    assert.equal(v.reason, "unknown");
  }
  assert.match(classify("SomethingNew").detail, /SomethingNew/);
});

test("a relayer's decline says whether to wait, hold, or call it a double spend", () => {
  assert.equal(classify({ RelayDeclined: { reason: "budget", retryable: true } }).kind, "blocked");
  assert.equal(classify({ RelayDeclined: { reason: "odd", retryable: false } }).kind, "held");
  const lost = classify({ RelayDeclined: { reason: "a different voucher at this sequence was already submitted", retryable: false, conflict: true } });
  assert.equal(lost.kind, "refused");
  if (lost.kind === "refused") assert.equal(lost.reason, "paid-to-someone-else");
});
