/**
 * Reading the merchant's code on the payer's phone.
 *
 * The till already shows a Solana Pay request for customers who are online.
 * The offline customer scans the same code: it names the merchant and the
 * amount, which is everything a voucher needs from the merchant's side, and it
 * needs no network to read. So the offline sale is two scans, one each way,
 * and the till's screen does not change.
 *
 * Parsed by hand rather than with `URLSearchParams`. React Native's polyfill
 * has shipped `get` as "not implemented" for years, and a parser that works in
 * Node and throws on the phone is exactly the defect these tests cannot see.
 */
import { decodeBase58 } from "@nelo/voucher";

export type MerchantRequest =
  | { ok: true; merchant: string; amount: bigint; label?: string; message?: string }
  | { ok: false; reason: string };

/**
 * `text` is what the scanner returned; `mint` is the token this vault pays in.
 * `decimals` is that mint's — 6 for USDC.
 */
export function readMerchantCode(text: string, mint: string, decimals = 6): MerchantRequest {
  const no = (reason: string): MerchantRequest => ({ ok: false, reason });
  if (!text.startsWith("solana:")) return no("That is not a merchant's payment code.");

  const rest = text.slice("solana:".length);
  const q = rest.indexOf("?");
  const recipient = q === -1 ? rest : rest.slice(0, q);
  const query = q === -1 ? "" : rest.slice(q + 1);

  try {
    if (decodeBase58(recipient).length !== 32) return no("The merchant's address is not valid.");
  } catch {
    return no("The merchant's address is not valid.");
  }

  const params = new Map<string, string>();
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq));
    const value = decodeURIComponent((eq === -1 ? "" : pair.slice(eq + 1)).replace(/\+/g, " "));
    // First occurrence wins; a request that repeats `amount` is not one to guess at.
    if (params.has(key) && (key === "amount" || key === "spl-token")) {
      return no("The payment code is ambiguous.");
    }
    if (!params.has(key)) params.set(key, value);
  }

  const token = params.get("spl-token");
  if (token === undefined) return no("This code asks for SOL. Offline payments are in USDC.");
  if (token !== mint) return no("This code asks for a different token than your balance holds.");

  const amountText = params.get("amount");
  if (amountText === undefined) return no("The code has no amount. Ask the merchant to enter one.");
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amountText);
  if (!m) return no("The amount in the code is not a number.");
  const fraction = m[2] ?? "";
  if (fraction.length > decimals) return no("The amount has more decimals than the token allows.");
  const amount = BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (amount <= 0n) return no("The amount must be more than zero.");

  const out: MerchantRequest = { ok: true, merchant: recipient, amount };
  const label = params.get("label");
  const message = params.get("message");
  if (label) out.label = label;
  if (message) out.message = message;
  return out;
}
