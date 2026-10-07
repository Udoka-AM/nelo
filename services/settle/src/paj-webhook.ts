/**
 * Point paj.cash's order webhook at this service, and keep the signing secret
 * it answers with.
 *
 *   pnpm paj:webhook     in services/settle, after SETTLE_PUBLIC_URL is set
 *
 * `PATCH /pub/v2/webhook` sets the API key's `rampWebhookURL` and returns the
 * key's configuration, `webhookSecret` included: the `whsec_…` that signs
 * every delivery. The dashboard does not always show it, so this is how it is
 * fetched. It is written to settle.env as PAJ_WEBHOOK_SECRET and never
 * printed. Only the ramp webhook is changed; `paymentWebhookURL` is not sent,
 * so it is left as it was.
 *
 * Each order also names this URL itself, so this is about the secret more
 * than the address. Then paj.cash is asked to post a sample delivery to it
 * (`POST /pub/v2/webhook/test`), which shows whether the address answers.
 * Moves no money.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PAJ_API } from "./paj/client.ts";

const envFile = process.env.SETTLE_ENV_FILE?.trim() || join(homedir(), ".config", "nelo", "settle.env");
const base = (process.env.PAJ_API_BASE?.trim() || PAJ_API).replace(/\/+$/, "");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const apiKey = process.env.PAJ_API_KEY?.trim() || fail(`PAJ_API_KEY is not set in ${envFile}.`);
const publicUrl = (process.env.SETTLE_PUBLIC_URL?.trim() ?? "").replace(/\/+$/, "");
const pathSecret = process.env.SETTLE_WEBHOOK_SECRET?.trim() || fail(`SETTLE_WEBHOOK_SECRET is not set: run pnpm setup:env first.`);
if (!/^https:\/\/[^/\s]+\.[^/\s]+/.test(publicUrl)) {
  fail(
    `SETTLE_PUBLIC_URL must be this service's public https address (got "${publicUrl || "nothing"}").\n` +
      `Set it first: pnpm setup:env --settle-url https://NAME.ngrok-free.app/settle`,
  );
}
if (/^https:\/\/(name|yourname|your-domain|your-name|example)\./i.test(publicUrl)) {
  fail(`SETTLE_PUBLIC_URL is "${publicUrl}", which still has the docs' placeholder in it. Re-run pnpm setup:env with your own ngrok domain.`);
}
const webhookURL = `${publicUrl}/v1/paj/webhook/${pathSecret}`;

async function call(method: "PATCH" | "POST", path: string, body?: unknown): Promise<any> {
  let r: Response;
  try {
    r = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    // No answer at all: this Mac's network, not the key. Nothing was changed.
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    fail(
      `Could not reach ${new URL(base).host} from this Mac (${cause?.code ?? cause?.message ?? (e as Error).message}). Nothing was changed.\n` +
        `Check with: curl -sS -m 15 -o /dev/null -w "%{http_code}\\n" ${base}/pub/v2/bank\n` +
        `A number (401 is fine) means it is reachable; a timeout means this network, a VPN or a firewall is blocking it.`,
    );
  }
  const text = await r.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!r.ok) {
    const m = parsed?.message;
    fail(`paj.cash answered HTTP ${r.status}: ${Array.isArray(m) ? m.join(", ") : m ?? (text.slice(0, 200) || "no message")}`);
  }
  return parsed;
}

const config = await call("PATCH", "/pub/v2/webhook", { rampWebhookURL: webhookURL });
const secret = typeof config?.webhookSecret === "string" ? config.webhookSecret.trim() : "";
console.log(`paj.cash will post order updates to ${publicUrl}/v1/paj/webhook/…`);

if (!/^whsec_[0-9a-f]{16,}$/i.test(secret)) {
  console.warn("paj.cash did not return a signing secret. Cash-outs still work: the till asks paj.cash directly.");
} else {
  const lines = existsSync(envFile) ? readFileSync(envFile, "utf8").split("\n") : [];
  const i = lines.findIndex((l) => l.startsWith("PAJ_WEBHOOK_SECRET="));
  const before = i >= 0 ? lines[i]!.slice("PAJ_WEBHOOK_SECRET=".length).trim() : "";
  if (i >= 0) lines[i] = `PAJ_WEBHOOK_SECRET=${secret}`;
  else lines.push(`PAJ_WEBHOOK_SECRET=${secret}`);
  writeFileSync(envFile, lines.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
  chmodSync(envFile, 0o600);
  console.log(
    before === secret
      ? `The signing secret in ${envFile.replace(homedir(), "~")} is already current.`
      : `Saved the signing secret to ${envFile.replace(homedir(), "~")} (not shown). Restart the settle service to use it.`,
  );
}

// A sample delivery: does the address answer from the internet?
const test = await call("POST", "/pub/v2/webhook/test?type=RAMP");
const summary = JSON.stringify(test ?? {})
  .split(pathSecret)
  .join("…")
  .split(secret || "\u0000")
  .join("whsec_…");
console.log(`paj.cash's test delivery: ${summary.length > 300 ? `${summary.slice(0, 300)}…` : summary}`);
console.log("If it did not get a 2xx, check the gateway, ngrok and the settle service are all running.");
