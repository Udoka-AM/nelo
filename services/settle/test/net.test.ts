import { test } from "node:test";
import assert from "node:assert/strict";
import { reach } from "../src/net.ts";

const failure = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: { code } });

test("a failed DNS lookup is tried again: the request never left the machine", async () => {
  let calls = 0;
  const r = await reach("https://api.paj.cash", async () => {
    if (++calls < 3) throw failure("EAI_AGAIN");
    return "ok";
  }, [0, 0, 0]);
  assert.equal(r, "ok");
  assert.equal(calls, 3);
});

test("a lookup that keeps failing names the host and the cause, not 'fetch failed'", async () => {
  await assert.rejects(
    reach("https://api.paj.cash/pub/v2/x", async () => { throw failure("ENOTFOUND"); }, [0]),
    /cannot reach api\.paj\.cash: this computer could not look up its address \(DNS\) \[ENOTFOUND\]/,
  );
});

test("a reset after the request was sent is not retried: it may have arrived", async () => {
  let calls = 0;
  await assert.rejects(
    reach("https://api.paj.cash", async () => { calls++; throw failure("ECONNRESET"); }, [0, 0]),
    /cannot reach api\.paj\.cash: the connection failed \[ECONNRESET\]/,
  );
  assert.equal(calls, 1);
});

test("an error that is not a network failure passes through untouched", async () => {
  await assert.rejects(reach("https://x.test", async () => { throw new Error("paj.cash answered HTTP 400"); }), /HTTP 400/);
});
