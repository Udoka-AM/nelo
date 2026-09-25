/**
 * Settle on reconnect: turn queued vouchers into USDC in the merchant's account.
 *
 * `@nelo/queue` decides what to send, look up or give up on. This file supplies
 * the three things it cannot do itself: a blockhash, the merchant's wallet
 * signature, and the RPC calls.
 *
 * ## Who signs: nobody the merchant has to think about
 *
 * `redeem_voucher`'s only signer is whoever pays the fee. The merchant is an
 * account the program pays, fixed by the voucher itself. So Nelo's relayer
 * submits and pays, and the merchant signs nothing and needs no SOL, whether
 * they signed up with a wallet or through Privy. The relayer cannot redirect
 * the money: the program pays exactly the merchant the voucher names.
 *
 * The till records a signature only after the relayer answers, so crash
 * safety here rests on the relayer answering a repeated voucher with the same
 * signature while it can still land. It does; see `services/relay`.
 *
 * Without a relayer configured, a merchant who connected a wallet can still
 * settle by signing with it and paying the fee: the fallback, not the product.
 */
import { getBase64Decoder } from "@solana/kit";
import {
  relayPrepare,
  reportConflict,
  rpcStatuses,
  settleOnce,
  type Entry,
  type Relayer,
  type RoundReport,
  type SendResult,
  type SettleDeps,
} from "@nelo/queue";
import { buildRedemption, checkSigned, TOKEN_PROGRAM_ID } from "@nelo/redeem";
import { record } from "./daybook";
import { relayToken, relayUrl, rpcUrl } from "./config";
import { markBooked, markReported, unbooked, unreported, voucherStore } from "./offline";
import { signTransactions } from "./wallet";
import type { MerchantAccount } from "./account";

const relayer: Relayer = { url: relayUrl, ...(relayToken ? { token: relayToken } : {}) };

type Rpc = { result?: unknown; error?: { message?: string; data?: { err?: unknown } } };

async function call(method: string, params: unknown[]): Promise<Rpc> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  return (await response.json()) as Rpc;
}

async function result<T>(method: string, params: unknown[]): Promise<T> {
  const body = await call(method, params);
  if (body.error) throw new Error(`${method}: ${body.error.message ?? "RPC error"}`);
  return body.result as T;
}

export type Settled =
  | { kind: "round"; report: RoundReport; conflictsReported?: number }
  /** A Privy merchant: nothing here can sign for them yet. */
  | { kind: "unsupported"; reason: string }
  /** The wallet signed something other than what was built, or refused. */
  | { kind: "wallet"; reason: string };

/**
 * Send every double spend this till caught to the relayer. Offline, or the
 * relayer down, it stays for the next round.
 */
async function reportConflicts(): Promise<number> {
  let reported = 0;
  for (const c of await unreported()) {
    const outcome = await reportConflict(relayer, c.a, c.b);
    if (!outcome.done) continue;
    await markReported(c.id, outcome.status);
    if (outcome.status === "reported") reported++;
  }
  return reported;
}

export async function settleVouchers(merchant: MerchantAccount, mint: string): Promise<Settled> {
  if (relayUrl) {
    const report = await settleOnce(voucherStore, { now: () => Date.now(), prepare: relayPrepare(relayer), statuses });
    await bookSettled(mint);
    const conflictsReported = report.offline ? 0 : await reportConflicts();
    return { kind: "round", report, conflictsReported };
  }
  if (merchant.kind !== "wallet") {
    return {
      kind: "unsupported",
      reason: "Settling needs Nelo's relay, which this build is not configured with. Your payments are safe in the queue.",
    };
  }
  return settleWithWallet(merchant, mint);
}

/** The fallback: the merchant's own wallet signs and pays the fee. */
async function settleWithWallet(merchant: MerchantAccount, mint: string): Promise<Settled> {
  let walletProblem: string | null = null;

  const deps: SettleDeps = {
    now: () => Date.now(),

    async prepare(entry: Entry) {
      const blockhash = await result<{ value: { blockhash: string; lastValidBlockHeight: number } }>(
        "getLatestBlockhash",
        [{ commitment: "confirmed" }],
      );
      const unsigned = buildRedemption(
        { voucher: entry.packet, payer: merchant.address, mint, tokenProgram: TOKEN_PROGRAM_ID },
        {
          blockhash: blockhash.value.blockhash,
          lastValidBlockHeight: BigInt(blockhash.value.lastValidBlockHeight),
        },
      );
      const [signed] = await signTransactions([unsigned.wire]);
      const checked = checkSigned(unsigned, signed ?? new Uint8Array());
      if (!checked.ok) {
        // Nothing was sent, so nothing is recorded against the voucher. The
        // round stops, and the merchant is told why.
        walletProblem = checked.reason;
        throw new Error(checked.reason);
      }
      const wire = getBase64Decoder().decode(checked.wire);
      return {
        signature: checked.signature,
        async send(): Promise<SendResult> {
          let body: Rpc;
          try {
            body = await call("sendTransaction", [
              wire,
              { encoding: "base64", preflightCommitment: "confirmed" },
            ]);
          } catch (e) {
            return { kind: "unreachable", message: e instanceof Error ? e.message : "network error" };
          }
          if (body.error) {
            // Preflight simulation carries the transaction error the queue
            // classifies. Without one, the node refused for its own reasons.
            const err = body.error.data?.err;
            return err !== undefined && err !== null
              ? { kind: "rejected", err }
              : { kind: "unreachable", message: body.error.message ?? "RPC error" };
          }
          return { kind: "sent" };
        },
      };
    },

    statuses,
  };

  const report = await settleOnce(voucherStore, deps);
  if (walletProblem) return { kind: "wallet", reason: walletProblem };
  await bookSettled(mint);
  return { kind: "round", report };
}

const statuses = rpcStatuses(rpcUrl);

/**
 * Settled vouchers go into the day-book, once each. Keyed on the voucher's id,
 * so a second round cannot book the same takings twice.
 */
async function bookSettled(mint: string): Promise<void> {
  for (const u of await unbooked()) {
    await record({
      reference: u.entry.id,
      signature: u.entry.settledSignature!,
      localMinor: u.localMinor,
      currency: u.currency,
      amountBaseUnits: u.entry.amount,
      mint,
      // The sale happened when the goods changed hands, not when it settled.
      at: u.entry.takenAt,
      overpaid: false,
    });
    await markBooked(u.entry.id);
  }
}
