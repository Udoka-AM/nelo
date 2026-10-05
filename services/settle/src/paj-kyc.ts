/**
 * Submit government-ID KYC for the paj.cash account the saved session
 * belongs to: once, by the operator, for Nelo's own account. paj.cash links
 * an id to a single user, so this is the person whose email or phone
 * `pnpm paj:login` used.
 *
 *   pnpm paj:kyc            asks BVN or NIN, then the number
 *
 * The number is read from the terminal, sent once, and never printed,
 * logged or written anywhere.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { PajError, pajClient, PAJ_PRODUCTION, PAJ_STAGING } from "./paj/client.ts";
import { currentSession, fileSessionStore } from "./paj/session.ts";

const apiKey = process.env.PAJ_API_KEY?.trim();
if (!apiKey) {
  console.error("PAJ_API_KEY is not set.");
  process.exit(1);
}
const production = process.env.PAJ_ENV === "production";
const file = process.env.PAJ_SESSION_FILE?.trim() || join(homedir(), ".config", "nelo", "paj-session.json");
const session = currentSession(fileSessionStore(file), Date.now());

const rl = createInterface({ input: process.stdin, output: process.stdout });
const type = (await rl.question("ID type, BVN or NIN: ")).trim().toUpperCase();
if (type !== "BVN" && type !== "NIN") {
  rl.close();
  console.error("Type BVN or NIN.");
  process.exit(1);
}
const idNumber = (await rl.question(`${type} (11 digits): `)).trim();
rl.close();
if (!/^\d{11}$/.test(idNumber)) {
  console.error(`A ${type} is 11 digits.`);
  process.exit(1);
}

const client = pajClient({ baseUrl: production ? PAJ_PRODUCTION : PAJ_STAGING, apiKey });
try {
  const message = await client.submitKyc(session, idNumber, type, "NG");
  console.log(`paj.cash ${production ? "production" : "staging"}: ${message}`);
} catch (e) {
  console.error(e instanceof PajError ? `paj.cash refused it: ${e.message}` : e);
  process.exit(1);
}
