import { test } from "node:test";
import assert from "node:assert/strict";
import { color, contrast, PAIRS, type, touch } from "../src/tokens.ts";

test("contrast is computed as WCAG defines it", () => {
  assert.equal(contrast("#ffffff", "#000000").toFixed(1), "21.0");
  assert.equal(contrast("#777777", "#ffffff").toFixed(2), "4.48");
});

test("every text colour reaches WCAG AA, 4.5:1, on every surface it is used on", () => {
  for (const [fg, bg] of PAIRS) {
    const ratio = contrast(color[fg], color[bg]);
    assert.ok(ratio >= 4.5, `${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
  }
});

test("every colour is used in at least one tested pair", () => {
  const used = new Set(PAIRS.flat());
  const untested = (Object.keys(color) as (keyof typeof color)[]).filter(
    (k) => !used.has(k) && !["border", "borderStrong", "surfaceHigh", "primaryPressed"].includes(k) && !k.endsWith("Surface") && k !== "bg",
  );
  assert.deepEqual(untested, [], "a text colour nobody checked is how a faint grey creeps back in");
});

test("nothing is smaller than 13, and nothing to press is smaller than 48dp", () => {
  assert.ok(Math.min(...Object.values(type)) >= 13);
  assert.ok(touch >= 48);
});
