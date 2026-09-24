/**
 * The voucher as a QR code: `NV1:` followed by the 202 bytes in base45.
 *
 * ## Why text, and why base45
 *
 * A QR code can carry raw bytes, and 202 of them fit version 10 at error
 * correction M. But phone scanners hand the app a *string*, and a byte-mode
 * payload that is not valid UTF-8 is decoded, replaced or truncated on the way
 * there, differently by each scanner. A voucher that loses one byte fails its
 * signature check, and the merchant sees a refusal that looks like fraud.
 *
 * Base45 (RFC 9285) uses exactly the 45 characters of QR's alphanumeric mode,
 * which packs 2 characters into 11 bits. So it costs almost nothing over raw
 * bytes: 202 bytes become 303 characters, `NV1:` makes 307, and version 10-M
 * holds 311. The EU's COVID certificates made the same choice for the same
 * reason. The tests check the version with the QR library the apps render
 * with, rather than trusting this arithmetic.
 *
 * ## The prefix
 *
 * `NV1:` says "Nelo voucher, version 1". A merchant scanning the wrong code —
 * a Solana Pay URL, a menu link — gets "not a Nelo voucher" rather than a
 * base45 error. The `1` lets the format change later without guessing.
 */
/** `VOUCHER_LEN`, repeated here so this file does not import the index that re-exports it. */
const VOUCHER_LEN = 202;

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
const VALUE = new Map([...ALPHABET].map((c, i) => [c, i]));

export const QR_PREFIX = "NV1:";
/** Version 10 at error correction M, alphanumeric mode. */
export const QR_CAPACITY_V10_M = 311;

/** RFC 9285 base45. */
export function encodeBase45(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    let n = bytes[i]! * 256 + bytes[i + 1]!;
    const c = n % 45;
    n = (n - c) / 45;
    const d = n % 45;
    const e = (n - d) / 45;
    out += ALPHABET[c]! + ALPHABET[d]! + ALPHABET[e]!;
  }
  if (bytes.length % 2 === 1) {
    const n = bytes[bytes.length - 1]!;
    out += ALPHABET[n % 45]! + ALPHABET[Math.floor(n / 45)]!;
  }
  return out;
}

/** RFC 9285 base45, strictly: any character, length or value outside the spec throws. */
export function decodeBase45(text: string): Uint8Array {
  if (text.length % 3 === 1) throw new Error("base45 length is invalid");
  const out = new Uint8Array(Math.floor(text.length / 3) * 2 + (text.length % 3 === 2 ? 1 : 0));
  const digit = (ch: string) => {
    const v = VALUE.get(ch);
    if (v === undefined) throw new Error(`invalid base45 character '${ch}'`);
    return v;
  };
  let o = 0;
  for (let i = 0; i < text.length; i += 3) {
    if (i + 2 < text.length) {
      const n = digit(text[i]!) + digit(text[i + 1]!) * 45 + digit(text[i + 2]!) * 45 * 45;
      if (n > 0xffff) throw new Error("base45 triplet is out of range");
      out[o++] = n >> 8;
      out[o++] = n & 0xff;
    } else {
      const n = digit(text[i]!) + digit(text[i + 1]!) * 45;
      if (n > 0xff) throw new Error("base45 pair is out of range");
      out[o++] = n;
    }
  }
  return out;
}

/** The text to render as the payer's QR code. */
export function toQr(packet: Uint8Array): string {
  if (packet.length !== VOUCHER_LEN) throw new Error(`voucher must be ${VOUCHER_LEN} bytes, got ${packet.length}`);
  return QR_PREFIX + encodeBase45(packet);
}

export type FromQr = { ok: true; packet: Uint8Array } | { ok: false; reason: string };

/**
 * What the merchant's scanner read. Returns the 202 bytes, or says plainly
 * what was scanned instead. Signature and the rest are `@nelo/accept`'s job.
 */
export function fromQr(text: string): FromQr {
  if (!text.startsWith(QR_PREFIX)) {
    return { ok: false, reason: "That code is not a Nelo payment." };
  }
  let packet: Uint8Array;
  try {
    packet = decodeBase45(text.slice(QR_PREFIX.length));
  } catch {
    return { ok: false, reason: "The payment code did not read cleanly. Scan it again." };
  }
  if (packet.length !== VOUCHER_LEN) {
    return { ok: false, reason: "The payment code did not read cleanly. Scan it again." };
  }
  return { ok: true, packet };
}
