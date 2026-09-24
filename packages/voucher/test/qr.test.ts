/**
 * The voucher as a QR code. Two things are proven here rather than argued:
 * the codec is RFC 9285 exactly, and the QR library the apps render with
 * puts a real voucher in version 10 at error correction M.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { decodeBase45, encodeBase45, fromQr, QR_CAPACITY_V10_M, QR_PREFIX, toQr } from "../src/index.ts";

interface QrModel {
  version: number;
  segments: { mode: { id: string } }[];
}
const QRCode = createRequire(import.meta.url)("qrcode") as {
  create(text: string, options: { errorCorrectionLevel: string }): QrModel;
};

const VECTORS: { name: string; packetHex: string }[] = JSON.parse(
  readFileSync(new URL("../vectors/voucher-v1.json", import.meta.url), "utf8"),
);
const text = (s: string) => new TextEncoder().encode(s);
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));

test("base45 matches RFC 9285's examples", () => {
  assert.equal(encodeBase45(text("AB")), "BB8");
  assert.equal(encodeBase45(text("Hello!!")), "%69 VD92EX0");
  assert.equal(encodeBase45(text("base-45")), "UJCLQE7W581");
  assert.deepEqual(decodeBase45("QED8WEX0"), text("ietf!"));
});

test("base45 refuses what RFC 9285 calls invalid", () => {
  assert.throws(() => decodeBase45("GGW"), /out of range/, "65536 does not fit two bytes");
  assert.throws(() => decodeBase45("ZZ"), /out of range/, "a trailing pair above 255");
  assert.throws(() => decodeBase45("BB8B"), /length/);
  assert.throws(() => decodeBase45("bb8"), /invalid base45 character/, "lowercase is not base45");
});

test("every golden voucher survives the trip through a QR string", () => {
  assert.ok(VECTORS.length >= 4);
  for (const v of VECTORS) {
    const packet = unhex(v.packetHex);
    const qr = toQr(packet);
    assert.equal(qr.length, QR_PREFIX.length + 303, v.name);
    const back = fromQr(qr);
    assert.ok(back.ok, v.name);
    if (back.ok) assert.deepEqual(back.packet, packet, v.name);
  }
});

test("a voucher renders at version 10, error correction M, in alphanumeric mode", () => {
  for (const v of VECTORS) {
    const qr = toQr(unhex(v.packetHex));
    assert.ok(qr.length <= QR_CAPACITY_V10_M, v.name);
    const model = QRCode.create(qr, { errorCorrectionLevel: "M" });
    assert.ok(model.version <= 10, `${v.name}: version ${model.version}`);
    assert.ok(
      model.segments.every((s) => s.mode.id === "Alphanumeric" || s.mode.id === "Numeric"),
      `${v.name}: no byte-mode segment, so no scanner has to guess an encoding`,
    );
  }
});

test("arbitrary packets round-trip", () => {
  let x = 7;
  for (let n = 0; n < 500; n++) {
    const packet = Uint8Array.from({ length: 202 }, () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) >> 16) & 0xff);
    const back = fromQr(toQr(packet));
    assert.ok(back.ok);
    if (back.ok) assert.deepEqual(back.packet, packet);
  }
});

test("a code that is not a Nelo payment says so", () => {
  const r = fromQr("solana:9EDhKVwHe5csswhp5PcY1DDwJRkfsrZKao7vsQPe7yrh?amount=1");
  assert.deepEqual(r, { ok: false, reason: "That code is not a Nelo payment." });
});

test("a damaged read asks for a rescan rather than failing later as fraud", () => {
  const qr = toQr(unhex(VECTORS[0]!.packetHex));
  for (const damaged of [qr.slice(0, -3), qr.toLowerCase().replace("nv1:", "NV1:"), qr + "\n"]) {
    const r = fromQr(damaged);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /Scan it again/);
  }
});

test("toQr refuses anything but a whole voucher", () => {
  assert.throws(() => toQr(new Uint8Array(201)), /202 bytes/);
});
