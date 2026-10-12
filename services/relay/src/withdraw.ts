/**
 * Send tokens out of the relayer's fee-payer wallet: for USDC sent there by
 * mistake. The fee payer holds only SOL for fees by design, so anything else
 * in it is someone's money to return.
 *
 *   pnpm withdraw --to <wallet address> --amount 2          shows what it would send
 *   pnpm withdraw --to <wallet address> --amount 2 --yes    sends it
 *
 * Mainnet USDC through RELAY_CASHOUT_RPC_URL by default; --mint picks another
 * token, --rpc another endpoint. The recipient's token account is opened if
 * it has none (idempotent; the fee payer pays). Signed with RELAY_KEYPAIR.
 */
import { parseArgs } from "node:util";
import {
  associatedTokenAddress,
  TOKEN_PROGRAM_ID,
  buildTransaction,
  createDepositAccountInstruction,
  transferCheckedInstruction,
  withSignature,
} from "@nelo/redeem";
import { encodeBase58 } from "@nelo/voucher";
import { loadFeePayer } from "./feePayer.ts";
import { createRelayRpc } from "./rpc.ts";

const USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const { values: args } = parseArgs({
  options: {
    to: { type: "string" },
    amount: { type: "string" },
    mint: { type: "string" },
    decimals: { type: "string" },
    rpc: { type: "string" },
    yes: { type: "boolean" },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const keypairPath = process.env.RELAY_KEYPAIR?.trim() || fail("RELAY_KEYPAIR is not set (run from services/relay with pnpm withdraw).");
const rpcUrl = args.rpc?.trim() || process.env.RELAY_CASHOUT_RPC_URL?.trim() || fail("No mainnet RPC: set RELAY_CASHOUT_RPC_URL or pass --rpc.");
const to = args.to?.trim() || fail("--to <wallet address> is required: the wallet the tokens go back to.");
if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to)) fail(`"${to}" is not a Solana address.`);
const mint = args.mint?.trim() || USDC_MAINNET;
const decimals = Number(args.decimals ?? "6");
const amountText = args.amount?.trim() || fail("--amount is required, in whole tokens: 2 means 2 USDC.");
const m = new RegExp(`^(\\d+)(?:\\.(\\d{1,${decimals}}))?$`).exec(amountText) ?? fail(`"${amountText}" is not an amount.`);
const amount = BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt((m[2] ?? "").padEnd(decimals, "0") || "0");
if (amount <= 0n) fail("Nothing to send.");

const feePayer = loadFeePayer(keypairPath);
if (to === feePayer.address) fail("That is the fee payer itself.");
const rpc = createRelayRpc(rpcUrl);
const host = new URL(rpcUrl).host;

console.log(`From   ${feePayer.address} (the relayer's fee payer)`);
console.log(`To     ${to}`);
console.log(`Amount ${amountText} of ${mint === USDC_MAINNET ? "USDC (mainnet)" : mint}`);
console.log(`Via    ${host}`);
if (!(await rpc.accountExists(associatedTokenAddress(feePayer.address, mint, TOKEN_PROGRAM_ID)))) {
  fail("The fee payer holds none of that token on this network: check the RPC is mainnet and the mint is right.");
}
if (!args.yes) {
  console.log("\nNothing sent. Check the address, then run it again with --yes.");
  process.exit(0);
}

const lifetime = await rpc.latestBlockhash();
const unsigned = buildTransaction(
  [
    createDepositAccountInstruction({ payer: feePayer.address, owner: to, mint }),
    transferCheckedInstruction({ owner: feePayer.address, destinationOwner: to, mint, amount, decimals }),
  ],
  feePayer.address,
  { blockhash: lifetime.blockhash, lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight) },
);
const signature = feePayer.sign(unsigned.message);
const wire = withSignature(unsigned.wire, feePayer.address, signature);
const sent = await rpc.send(Buffer.from(wire).toString("base64"));
if (!sent.ok) fail(`Refused before sending, nothing moved: ${JSON.stringify(sent.err)}`);
const sig = encodeBase58(signature);
console.log(`\nSent: ${sig}\nhttps://solscan.io/tx/${sig}`);
