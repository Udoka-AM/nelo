/**
 * Settle on reconnect: turn queued vouchers into USDC in the merchant's account.
 *
 * `@nelo/queue` decides what to send, look up or give up on. This file supplies
 * the three things it cannot do itself: a blockhash, the merchant's wallet
 * signature, and the RPC calls.
 *
 * ## Who signs
 *
 * The merchant's own wallet, over Mobile Wallet Adapter. It pays the fee, so
 * the merchant needs a little SOL. That was the choice for the week-3 gate:
 * fewest moving parts. The relayer can take over the fee later without
 * changing the queue. A merchant onboarded through Privy has no wallet app to
 * hand a transaction to, and Privy's own signer wants `@solana/web3.js`
 * objects this app does not carry, so for them settling says so rather than
 * failing oddly. That is a gap with a name, not an accident.
 */
import { getBase64Decoder } from "@solana/kit";
import {
  settleOnce,
  type Entry,
  type RoundReport,
  type SendResult,
  type SettleDeps,
  type SignatureStatus,
} from "@nelo/queue";
import { buildRedemption, checkSigned, TOKEN_PROGRAM_ID } from "@nelo/redeem";
import { record } from "./daybook";
import { rpcUrl } from "./config";
import { markBooked, unbooked, voucherStore } from "./offline";
import { signTransactions } from "./wallet";
import type { MerchantAccount } from "./account";

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
  | { kind: "round"; report: RoundReport }
  /** A Privy merchant: nothing here can sign for them yet. */
  | { kind: "unsupported"; reason: string }
  /** The wallet signed something other than what was built, or refused. */
  | { kind: "wallet"; reason: string };

export async function settleVouchers(merchant: MerchantAccount, mint: string): Promise<Settled> {
  if (merchant.kind !== "wallet") {
    return {
      kind: "unsupported",
      reason: "Settling offline payments needs a connected wallet for now. Your payments are safe in the queue.",
    };
  }

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

    async statuses(signatures) {
      const value = await result<{
        value: ({ err: unknown; confirmationStatus: string | null } | null)[];
      }>("getSignatureStatuses", [[...signatures], { searchTransactionHistory: true }]);
      const out = new Map<string, SignatureStatus>();
      signatures.forEach((signature, i) => {
        const s = value.value[i];
        if (!s) out.set(signature, { kind: "not-found" });
        else if (s.err) out.set(signature, { kind: "failed", err: s.err });
        else if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") {
          out.set(signature, { kind: "confirmed" });
        } else out.set(signature, { kind: "processing" });
      });
      return out;
    },
  };

  const report = await settleOnce(voucherStore, deps);
  if (walletProblem) return { kind: "wallet", reason: walletProblem };
  await bookSettled(mint);
  return { kind: "round", report };
}

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
