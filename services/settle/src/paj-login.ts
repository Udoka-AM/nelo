/**
 * Log in to paj.cash: it sends a one-time code, you type it, and the session
 * token is saved for the service to use until it expires.
 *
 *   PAJ_API_KEY=… pnpm paj:login            (asks for the email or phone)
 *   PAJ_LOGIN=ops@nelo.app PAJ_API_KEY=… pnpm paj:login
 *
 * The token is written owner-only to PAJ_SESSION_FILE, by default
 * ~/.config/nelo/paj-session.json. It is never printed.
 */
import { mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { pajClient, PAJ_PRODUCTION, PAJ_STAGING } from "./paj/client.ts";
import { fileSessionStore } from "./paj/session.ts";

const apiKey = process.env.PAJ_API_KEY?.trim();
if (!apiKey) {
  console.error("PAJ_API_KEY is not set.");
  process.exit(1);
}
const production = process.env.PAJ_ENV === "production";
const file = process.env.PAJ_SESSION_FILE?.trim() || join(homedir(), ".config", "nelo", "paj-session.json");
mkdirSync(dirname(file), { recursive: true });

const rl = createInterface({ input: process.stdin, output: process.stdout });
const recipient = process.env.PAJ_LOGIN?.trim() || (await rl.question("Email or phone (+234…) for paj.cash: ")).trim();
const client = pajClient({ baseUrl: production ? PAJ_PRODUCTION : PAJ_STAGING, apiKey });

await client.initiate(recipient);
const otp = (await rl.question(`Code sent to ${recipient}. Enter it: `)).trim();
rl.close();

const session = await client.verify(recipient, otp, { uuid: `nelo-settle-${hostname()}`, device: "Server" });
fileSessionStore(file).write(session);
console.log(`Logged in to paj.cash ${production ? "production" : "staging"}. Session saved to ${file}, valid until ${new Date(session.expiresAt).toISOString()}.`);
