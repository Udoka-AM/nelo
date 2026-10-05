/**
 * Verifying a paj.cash webhook delivery, per https://docs.paj.cash/concepts/webhook-signatures
 *
 *   X-PAJ-Timestamp: 1788224623            (Unix seconds)
 *   X-PAJ-Signature: v1=<hex HMAC-SHA256>  over `${timestamp}.${raw body}`
 *
 * keyed with the API key's `webhookSecret` (`whsec_…`). The timestamp is inside
 * the signed string, so a captured delivery cannot be replayed once the window
 * has passed; retries are re-signed with a fresh timestamp, so a window of
 * five minutes never refuses a genuine retry.
 *
 * Verified against the raw body, as received: a body parsed and re-serialised
 * is different bytes, and fails intermittently rather than always.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_WINDOW_SECONDS = 300;

export type WebhookCheck = { ok: true } | { ok: false; reason: string };

export function verifyPajWebhook(
  rawBody: string,
  headers: { timestamp: string | undefined; signature: string | undefined },
  secret: string,
  nowSeconds: number,
): WebhookCheck {
  const timestamp = headers.timestamp?.trim() ?? "";
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "no timestamp" };
  if (Math.abs(nowSeconds - Number(timestamp)) > WEBHOOK_WINDOW_SECONDS) return { ok: false, reason: "stale or future timestamp" };

  // Match on the scheme prefix: a second scheme may be sent alongside v1.
  const candidates = (headers.signature ?? "")
    .split(/[,\s]+/)
    .filter((p) => p.startsWith("v1="))
    .map((p) => p.slice(3));
  if (candidates.length === 0) return { ok: false, reason: "no v1 signature" };

  const expected = Buffer.from(createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex"));
  for (const c of candidates) {
    const got = Buffer.from(c.toLowerCase());
    if (got.length === expected.length && timingSafeEqual(got, expected)) return { ok: true };
  }
  return { ok: false, reason: "signature does not match" };
}
