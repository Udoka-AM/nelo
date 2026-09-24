/**
 * Base58 and base64, implemented rather than depended upon.
 *
 * Hermes has no Buffer and its atob support varies by React Native version, so
 * these run identically in Node and on the phone — which is what makes the
 * tests actually cover the device.
 */
/** Base58 — Solana's alphabet, no 0, O, I or l. */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  // Starts empty, not [0]: a seeded zero digit appends a spurious '1' and
  // corrupts every value whose magnitude is zero or has leading zero bytes.
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  // Leading zero bytes are encoded as '1', one each.
  let out = "";
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out += "1";
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]!];
  return out;
}

export function decodeBase58(s: string): Uint8Array {
  if (s.length === 0) return new Uint8Array(0);
  const bytes: number[] = [];
  for (const ch of s) {
    const value = B58.indexOf(ch);
    if (value === -1) throw new Error(`invalid base58 character '${ch}'`);
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leading = 0;
  for (let i = 0; i < s.length && s[i] === "1"; i++) leading++;
  return Uint8Array.from([...new Array(leading).fill(0), ...bytes.reverse()]);
}

// ---------------------------------------------------------- base64 ---

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Hermes has no Buffer and its atob support varies by RN version, so this is
 * implemented rather than polyfilled — it runs identically in Node and on the
 * phone, which means the test below actually covers the device.
 */
export function decodeBase64(s: string): Uint8Array {
  const clean = s.replace(/=+$/, "");
  const out = new Uint8Array((clean.length * 3) >> 2);
  let bits = 0;
  let acc = 0;
  let index = 0;
  for (const ch of clean) {
    const value = B64.indexOf(ch);
    if (value === -1) throw new Error(`invalid base64 character '${ch}'`);
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, index);
}

/**
 * Mobile Wallet Adapter hands back account addresses base64-encoded; Solana Pay
 * URLs and every explorer want base58. Getting this wrong produces a valid
 * looking address that belongs to nobody, and the money goes nowhere
 * recoverable — so it is converted in one place, and tested.
 */
export function base64AddressToBase58(address: string): string {
  const bytes = decodeBase64(address);
  if (bytes.length !== 32) {
    throw new Error(`expected a 32-byte address, decoded ${bytes.length} bytes`);
  }
  return encodeBase58(bytes);
}
