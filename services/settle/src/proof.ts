/**
 * Print the evidence for paid cash-outs, safe to share: the Solscan link for
 * the mainnet USDC transfer, paj.cash's order id, the amounts, how long it
 * took, and the bank with all but the last four digits of the account hidden.
 *
 *   pnpm proof            every cash-out paj.cash has paid
 *   pnpm proof --all      every cash-out, whatever its state
 *
 * Reads the settlement service's own records (SETTLE_CASHOUTS_FILE, default
 * ~/.config/nelo/cashouts.json). Calls nothing and changes nothing.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CashoutFile } from "./cashout.ts";

const path = process.env.SETTLE_CASHOUTS_FILE?.trim() || join(homedir(), ".config", "nelo", "cashouts.json");
if (!existsSync(path)) {
  console.error(`No cash-out records at ${path}. Run this on the machine that runs the settlement service.`);
  process.exit(1);
}
const all = process.argv.includes("--all");
const file = JSON.parse(readFileSync(path, "utf8")) as CashoutFile;
const rows = Object.values(file.cashouts)
  .filter((c) => all || c.state === "paid")
  .sort((a, b) => a.createdAt - b.createdAt);
if (rows.length === 0) {
  console.log(all ? "No cash-outs recorded." : "No paid cash-outs yet. Try --all to see every state.");
  process.exit(0);
}

/** `bank:NG:058:0123456789` → `NG bank 058, account ******6789`. */
function redact(destination: string): string {
  const [, country, bank, account] = destination.split(":");
  return `${country} bank ${bank}, account ${"*".repeat(Math.max(0, (account ?? "").length - 4))}${(account ?? "").slice(-4)}`;
}
const usdc = (minor: string | null) => (minor ? `${(Number(minor) / 1e6).toFixed(2)} USDC` : "—");
const naira = (minor: string | null) =>
  minor ? `₦${(Number(minor) / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}` : "—";

for (const c of rows) {
  console.log(`Cash-out ${c.id}`);
  console.log(`  State          ${c.state}${c.detail ? ` (${c.detail})` : ""}`);
  console.log(`  Opened         ${new Date(c.createdAt).toISOString()}`);
  console.log(`  Last update    ${new Date(c.updatedAt).toISOString()}  (${Math.round((c.updatedAt - c.createdAt) / 1000)} s after opening)`);
  console.log(`  Sent           ${usdc(c.fundMinor ?? c.tokenMinor)} on Solana mainnet`);
  console.log(`  Paid out       ${naira(c.localMinor)} to ${redact(c.destination)}`);
  console.log(`  Partner order  ${c.partner} ${c.reference ?? "—"}`);
  console.log(`  Transfer       ${c.transferSignature ? `https://solscan.io/tx/${c.transferSignature}` : "—"}`);
  console.log("");
}
