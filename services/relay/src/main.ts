/**
 * Run the relayer.
 *
 *   RELAY_RPC_URL           devnet RPC with a real quota (e.g. Helius)
 *   RELAY_KEYPAIR           fee-payer keypair file (solana-keygen format)
 *   RELAY_TOKEN             bearer token the merchant app sends (optional)
 *   RELAY_LEDGER            where submissions are remembered (default ./relay-ledger.json)
 *   RELAY_PORT / RELAY_HOST default 8787 on 127.0.0.1: a tunnel fronts it
 *   RELAY_DAILY_BUDGET_SOL  default 0.5
 *   RELAY_MAX_PER_VAULT     redemptions per vault per day, default 200
 *
 * See docs-site/operations/relay.mdx for running it on a Mac behind a tunnel.
 */
import { loadFeePayer } from "./feePayer.ts";
import { fileLedger, utcDay } from "./ledger.ts";
import { createRelayRpc } from "./rpc.ts";
import { buildServer } from "./server.ts";

const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is not set. See the header of services/relay/src/main.ts.`);
    process.exit(1);
  }
  return value;
}

const now = () => Math.floor(Date.now() / 1000);
const feePayer = loadFeePayer(required("RELAY_KEYPAIR"));
const mint = process.env.RELAY_MINT?.trim() || USDC_DEVNET;
const budgetSol = Number(process.env.RELAY_DAILY_BUDGET_SOL ?? "0.5");

const app = buildServer({
  now,
  ...(process.env.RELAY_TOKEN?.trim() ? { token: process.env.RELAY_TOKEN.trim() } : {}),
  deps: {
    rpc: createRelayRpc(required("RELAY_RPC_URL")),
    feePayer,
    ledger: fileLedger(process.env.RELAY_LEDGER?.trim() || "relay-ledger.json", utcDay(now())),
    config: {
      mint,
      limits: {
        budgetLamports: Math.round(budgetSol * 1_000_000_000),
        maxPerVault: Number(process.env.RELAY_MAX_PER_VAULT ?? "200"),
        allowedMints: [mint],
        // Once per merchant, enforced by the ledger. The first offline sale to
        // a merchant who has never held USDC must not fail on that.
        sponsorNewAccounts: true,
      },
    },
  },
});

const port = Number(process.env.RELAY_PORT ?? "8787");
const host = process.env.RELAY_HOST?.trim() || "127.0.0.1";
await app.listen({ port, host });
console.log(`nelo relay on http://${host}:${port} · fee payer ${feePayer.address} · mint ${mint}`);
if (!process.env.RELAY_TOKEN) console.warn("RELAY_TOKEN is not set: anyone who finds the URL can submit vouchers.");
