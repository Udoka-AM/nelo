/**
 * The capability record.
 *
 * Every test here guards a way the dataset could be quietly wrong — which is
 * worse than having no dataset, because a wrong count still gets quoted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  capability,
  capabilityLine,
  recordKeys,
  type CapabilityInput,
} from "../src/capability.ts";

const AT = Date.UTC(2026, 8, 23, 12, 0, 0);

const input = (over: Partial<CapabilityInput> = {}): CapabilityInput => ({
  moduleLoaded: true,
  strongBox: false,
  observedAt: AT,
  build: { apiLevel: 33, release: "13", manufacturer: "Xiaomi", model: "Redmi Note 12" },
  ...over,
});

// ------------------------------------------------------------- the answer ---

test("a handset with the secure element records strongbox", () => {
  assert.equal(capability(input({ strongBox: true })).backing, "strongbox");
});

/**
 * The distinction the whole module exists for. `isStrongBoxAvailable()` checks
 * one system feature; it cannot see whether the Keystore is TEE-backed or
 * software-backed, so the absence of StrongBox is recorded as exactly that and
 * nothing more.
 */
test("no secure element is recorded as no-strongbox, never as tee", () => {
  const record = capability(input({ strongBox: false }));
  assert.equal(record.backing, "no-strongbox");
  assert.notEqual(record.backing, "tee" as unknown as string);
});

/**
 * The false negative that would matter. A build without the native module never
 * asked the hardware, so its `false` means "not asked", not "not present" —
 * and counting it as absent would under-count StrongBox across the dataset.
 */
test("a build with no native module is unknown, even when strongBox reads false", () => {
  assert.equal(capability(input({ moduleLoaded: false, strongBox: false })).backing, "unknown");
});

test("a build with no native module is unknown even when strongBox reads true", () => {
  // Nothing should be able to produce this, which is the point: if something
  // ever does, it is not evidence and must not be recorded as evidence.
  assert.equal(capability(input({ moduleLoaded: false, strongBox: true })).backing, "unknown");
});

// -------------------------------------------------------------- hygiene ---

test("the record carries no device identifier", () => {
  // Serial and Fingerprint are both available on Platform.constants and both
  // identify a handset. If either is ever added, this fails first.
  const record = capability(input());
  assert.deepEqual(Object.keys(record).sort(), [...recordKeys].sort());
});

test("a blank model is missing data, not an empty value", () => {
  const record = capability(input({ build: { model: "   ", manufacturer: "" } }));
  assert.equal(record.model, null);
  assert.equal(record.manufacturer, null);
});

test("padded strings are trimmed rather than counted as distinct handsets", () => {
  const record = capability(input({ build: { manufacturer: " Xiaomi ", model: " Redmi 12 " } }));
  assert.equal(record.manufacturer, "Xiaomi");
  assert.equal(record.model, "Redmi 12");
});

/**
 * `Platform.Version` is a number on Android and a string everywhere else, so a
 * record built anywhere else must not carry an integer that looks measured.
 */
test("an API level that is not a positive integer is null", () => {
  for (const bad of ["33", 0, -1, 33.5, Number.NaN, null, undefined]) {
    const record = capability(input({ build: { apiLevel: bad as number } }));
    assert.equal(record.apiLevel, null, `accepted ${String(bad)}`);
  }
  assert.equal(capability(input({ build: { apiLevel: 28 } })).apiLevel, 28);
});

test("a record from a host with no build info is all nulls, not an exception", () => {
  const record = capability({ moduleLoaded: false, strongBox: false, observedAt: AT });
  assert.equal(record.apiLevel, null);
  assert.equal(record.model, null);
  assert.equal(record.backing, "unknown");
});

test("the timestamp is to the second, and reproducible from its input", () => {
  assert.equal(capability(input()).observedAt, "2026-09-23T12:00:00Z");
  assert.equal(capability(input()).observedAt, capability(input()).observedAt);
});

// ----------------------------------------------------------- the line ---

test("the line is a person-readable row that keeps its columns", () => {
  const line = capabilityLine(capability(input({ strongBox: true })));
  assert.deepEqual(line.split("\t"), [
    "strongbox",
    "Xiaomi",
    "Redmi Note 12",
    "api33",
    "2026-09-23T12:00:00Z",
  ]);
});

test("missing fields hold their column rather than collapsing it", () => {
  // A row that loses a column silently misaligns every row pasted after it.
  const line = capabilityLine(capability({ moduleLoaded: false, strongBox: false, observedAt: AT }));
  assert.equal(line.split("\t").length, 5);
  assert.deepEqual(line.split("\t"), ["unknown", "?", "?", "api?", "2026-09-23T12:00:00Z"]);
});
