/**
 * The settings the relayer, the settlement service and both apps need, set up
 * in one go on the machine that runs them.
 *
 *   pnpm setup:env
 *   pnpm setup:env --relay-url https://….trycloudflare.com --settle-url https://….trycloudflare.com
 *
 * It writes:
 *
 *   ~/.config/nelo/relay.env    the relayer's settings; its token is generated
 *   ~/.config/nelo/settle.env   the settlement service's; token and webhook secret generated
 *   apps/merchant/.env          from .env.example if missing, with both tokens copied in
 *   apps/payer/.env             from .env.example if missing, with the relayer's token
 *
 * `pnpm start` in services/relay and services/settle loads its file itself.
 *
 * Run it again whenever you like. A value you have set is never changed, and
 * generated secrets are kept, so the apps' copies stay valid. The one thing it
 * does overwrite is a tunnel URL you pass it, because a quick tunnel's address
 * changes every time cloudflared restarts.
 *
 * Nothing it writes is inside git: the service files live under ~/.config, and
 * both apps' .env files are ignored.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = homedir();
const configDir = join(home, ".config", "nelo");
const solanaDir = join(home, ".config", "solana", "nelo");

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  const v = i >= 0 ? args[i + 1] : undefined;
  // A real address: plain ASCII host, not the "…" placeholder copied from the docs.
  if (i >= 0 && (!v || !/^https:\/\/[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(:\d+)?(\/\S*)?$/.test(v))) {
    console.error(
      `${name} needs the real https:// address cloudflared printed, e.g. https://blue-sky-1234.trycloudflare.com, not "${v ?? ""}".`,
    );
    process.exit(1);
  }
  return v?.replace(/\/+$/, "");
};
const relayUrl = flag("--relay-url");
const settleUrl = flag("--settle-url");

/** A dotenv file, edited line by line so comments and order survive. */
class EnvFile {
  readonly path: string;
  lines: string[];
  changed: string[] = [];
  constructor(path: string, template?: string) {
    this.path = path;
    this.lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : (template ?? "").split("\n");
  }
  get(key: string): string {
    const line = this.lines.find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).replace(/^['"]|['"]$/g, "").trim() : "";
  }
  /** Set `key`, unless it already has a value and `force` is off. */
  set(key: string, value: string, force = false): void {
    const i = this.lines.findIndex((l) => l.startsWith(`${key}=`));
    if (i >= 0) {
      const current = this.get(key);
      if (current === value || (current && !force)) return;
      this.lines[i] = `${key}=${value}`;
    } else {
      if (this.lines.length && this.lines[this.lines.length - 1] !== "") this.lines.push("");
      this.lines.push(`${key}=${value}`);
    }
    this.changed.push(key);
  }
  save(secret: boolean): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, this.lines.join("\n").replace(/\n*$/, "\n"), { mode: secret ? 0o600 : 0o644 });
    if (secret) chmodSync(this.path, 0o600);
  }
}

const secret = (bytes: number) => randomBytes(bytes).toString("hex");

const RELAY_TEMPLATE = `# The relayer's settings, loaded by \`pnpm start\` in services/relay.
# Written by \`pnpm setup:env\`. Owner-only: this file holds a token and key paths.

# Devnet RPC with a real quota, e.g. https://devnet.helius-rpc.com/?api-key=…
RELAY_RPC_URL=
# Optional: tried in order when the one above does not answer. Comma-separated.
RELAY_RPC_FALLBACK_URLS=
RELAY_KEYPAIR=
RELAY_LEDGER=
RELAY_TOKEN=

# Optional, shown with their defaults:
# RELAY_DAILY_BUDGET_SOL=0.5
# RELAY_MAX_PER_VAULT=200
# RELAY_CASHOUTS_PER_DAY=5
# Only if paj.cash's deposit addresses have no USDC token account (~0.002 SOL each):
# RELAY_SPONSOR_DEPOSIT_ACCOUNTS=true
# RELAY_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
# RELAY_MINT_DECIMALS=6
# RELAY_PORT=8787
# RELAY_HOST=127.0.0.1
`;

const SETTLE_TEMPLATE = `# The settlement service's settings, loaded by \`pnpm start\` and
# \`pnpm paj:login\` in services/settle. Written by \`pnpm setup:env\`.
# Owner-only: PAJ_API_KEY is Nelo's paj.cash business key and never leaves this machine.

PAJ_API_KEY=
PAJ_ENV=staging
# This service's public https address (its own tunnel, port 8788).
SETTLE_PUBLIC_URL=
SETTLE_WEBHOOK_SECRET=
SETTLE_TOKEN=

# Optional:
# The email or +234… number paj.cash sends the login code to; skips the prompt.
# PAJ_LOGIN=
# If paj.cash staging wants a mint other than devnet USDC:
# SETTLE_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
# Nelo's fee per cash-out, in USDC:
# NELO_FEE_USDC=
# SETTLE_PORT=8788
# SETTLE_HOST=127.0.0.1
`;

// ---- the services ----

const relay = new EnvFile(join(configDir, "relay.env"), RELAY_TEMPLATE);
relay.set("RELAY_KEYPAIR", join(solanaDir, "relay-fee-payer.json"));
relay.set("RELAY_LEDGER", join(solanaDir, "relay-ledger.json"));
relay.set("RELAY_TOKEN", secret(24));

const settle = new EnvFile(join(configDir, "settle.env"), SETTLE_TEMPLATE);
settle.set("SETTLE_WEBHOOK_SECRET", secret(16));
settle.set("SETTLE_TOKEN", secret(24));
if (settleUrl) settle.set("SETTLE_PUBLIC_URL", settleUrl, true);

// ---- the apps ----

function appEnv(app: string): EnvFile {
  const path = join(root, "apps", app, ".env");
  if (!existsSync(path)) copyFileSync(join(root, "apps", app, ".env.example"), path);
  return new EnvFile(path);
}

const merchant = appEnv("merchant");
const payer = appEnv("payer");

// An earlier version accepted the docs' "https://….trycloudflare.com" placeholder. Clear it.
for (const [f, key] of [
  [merchant, "EXPO_PUBLIC_NELO_RELAY_URL"],
  [merchant, "EXPO_PUBLIC_NELO_SETTLE_URL"],
  [payer, "EXPO_PUBLIC_NELO_RELAY_URL"],
  [settle, "SETTLE_PUBLIC_URL"],
] as const) {
  if (f.get(key).includes("…")) f.set(key, "", true);
}

// The tokens are the services'; the apps hold copies, kept in step.
merchant.set("EXPO_PUBLIC_NELO_RELAY_TOKEN", relay.get("RELAY_TOKEN"), true);
merchant.set("EXPO_PUBLIC_NELO_SETTLE_TOKEN", settle.get("SETTLE_TOKEN"), true);
payer.set("EXPO_PUBLIC_NELO_RELAY_TOKEN", relay.get("RELAY_TOKEN"), true);
if (relayUrl) {
  merchant.set("EXPO_PUBLIC_NELO_RELAY_URL", relayUrl, true);
  payer.set("EXPO_PUBLIC_NELO_RELAY_URL", relayUrl, true);
}
if (settleUrl) merchant.set("EXPO_PUBLIC_NELO_SETTLE_URL", settleUrl, true);

// One RPC for everything is fine for a demo: fill blanks from whichever has one.
const rpc = relay.get("RELAY_RPC_URL") || merchant.get("EXPO_PUBLIC_SOLANA_RPC_URL") || payer.get("EXPO_PUBLIC_SOLANA_RPC_URL");
if (rpc) {
  relay.set("RELAY_RPC_URL", rpc);
  merchant.set("EXPO_PUBLIC_SOLANA_RPC_URL", rpc);
  payer.set("EXPO_PUBLIC_SOLANA_RPC_URL", rpc);
}

relay.save(true);
settle.save(true);
merchant.save(false);
payer.save(false);

// ---- what is left for a person ----

const show = (f: EnvFile) => f.path.replace(home, "~").replace(`${root}/`, "");
for (const f of [relay, settle, merchant, payer]) {
  if (f.changed.length) console.log(`updated ${show(f)}: ${f.changed.join(", ")}`);
}

const todo: string[] = [];
const need = (f: EnvFile, key: string, what: string) => {
  if (!f.get(key)) todo.push(`  ${show(f)}  ${key}  — ${what}`);
};
need(relay, "RELAY_RPC_URL", "your Helius devnet URL");
need(settle, "PAJ_API_KEY", "from paj.cash (staging)");
need(settle, "SETTLE_PUBLIC_URL", "the settle tunnel: pnpm setup:env --settle-url https://…");
need(merchant, "EXPO_PUBLIC_NELO_RELAY_URL", "the relay tunnel: pnpm setup:env --relay-url https://…");
need(merchant, "EXPO_PUBLIC_NELO_SETTLE_URL", "the settle tunnel: pnpm setup:env --settle-url https://…");
need(payer, "EXPO_PUBLIC_NELO_RELAY_URL", "the relay tunnel: pnpm setup:env --relay-url https://…");
need(merchant, "EXPO_PUBLIC_PRIVY_APP_ID", "optional: from the Privy dashboard");

if (!existsSync(relay.get("RELAY_KEYPAIR"))) {
  todo.push(
    `  the relayer's fee-payer key does not exist yet:\n` +
      `    solana-keygen new -o ${relay.get("RELAY_KEYPAIR").replace(home, "~")}\n` +
      `    solana airdrop 2 $(solana address -k ${relay.get("RELAY_KEYPAIR").replace(home, "~")}) -u devnet`,
  );
}

// Ask the RPC one harmless question, so a refused key shows up here rather
// than as "sweep failed: HTTP 401" once the relayer is running.
const rpcUrl = relay.get("RELAY_RPC_URL");
if (rpcUrl) {
  try {
    const r = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      signal: AbortSignal.timeout(8_000),
    });
    const host = new URL(rpcUrl).host;
    if (r.status === 401 || r.status === 403) {
      todo.push(`  RELAY_RPC_URL (${host}) refuses the request: HTTP ${r.status}. The API key in it is wrong or missing: check it against the Helius dashboard.`);
    } else if (!r.ok) {
      todo.push(`  RELAY_RPC_URL (${host}) answered HTTP ${r.status}.`);
    } else {
      console.log(`RPC check: ${host} answers.`);
    }
  } catch {
    todo.push("  RELAY_RPC_URL could not be reached (no network, or not a URL).");
  }
}

console.log(todo.length ? `\nStill to fill in:\n${todo.join("\n")}` : "\nEverything is set.");
if (merchant.changed.length || payer.changed.length) {
  console.log("\nThe apps' .env changed: restart Metro with `npx expo start --dev-client --clear`.");
}
