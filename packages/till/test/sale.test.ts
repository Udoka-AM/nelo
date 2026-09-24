/**
 * The whole offline sale, both phones, no network: the two scans the week-3
 * gate performs by hand, run through the same packages the two apps use.
 *
 *   till shows its Solana Pay code → payer reads it (@nelo/issue)
 *   payer's key signs a voucher     → shown as a QR (@nelo/voucher)
 *   till scans it                   → takes it (@nelo/till)
 *   the same QR shown again         → refused
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { p256 } from "@noble/curves/p256";
import { enqueue, type Entry } from "@nelo/queue";
import { encodeTransferRequest } from "@nelo/pay";
import { initialState, pay, readMerchantCode, type IssuerState, type IssuerStore } from "@nelo/issue";
import { encodeBase58, toQr } from "@nelo/voucher";
import type { EnrolmentCache } from "@nelo/enrol";
import { scan } from "../src/index.ts";

const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const NOW = 1_789_000_000;
const MERCHANT = encodeBase58(new Uint8Array(32).fill(0x22));
const VAULT = encodeBase58(new Uint8Array(32).fill(0x11));
const SK = p256.utils.randomPrivateKey();
const DEVICE = p256.getPublicKey(SK, true);

test("two phones, no network: the sale completes, and the replayed voucher is refused", async () => {
  // The chain, as both phones last saw it.
  const chain = { balance: 100_000_000n, seqBase: 0n, seqBitmap: 0n, unlockAt: 0n, status: 0, limit: 50_000_000n, syncedAt: NOW - 60 };
  const cache: EnrolmentCache = {
    vaults: new Map([
      [VAULT, { vault: VAULT, devicePubkey: DEVICE, mint: USDC, balance: chain.balance, floorLimit: 50_000_000n, stake: 0n,
        pendingUnstake: 0n, reputationBps: 10_000, seqBase: 0n, seqBitmap: 0n, status: 0, syncedAt: NOW - 60 }],
    ]),
    risk: { kBps: 0, stakeReference: 1n, hardCap: 10n ** 12n, stakePrice: 0n, haircutBps: 0 },
    riskSyncedAt: NOW - 60,
    fullSyncAt: NOW - 60,
  };

  // 1. The till's screen: the ordinary Solana Pay code.
  const charged = 12_500_000n;
  const tillCode = encodeTransferRequest({ recipient: MERCHANT, amount: "12.5", splToken: USDC, reference: [MERCHANT], label: "Nelo" });

  // 2. The payer's phone reads it and signs.
  const request = readMerchantCode(tillCode, USDC);
  assert.ok(request.ok);
  if (!request.ok) return;
  let saved: IssuerState = initialState(VAULT, DEVICE, chain);
  const store: IssuerStore = { load: async () => saved, save: async (s) => void (saved = s) };
  const issued = await pay(
    store,
    async (m) => p256.sign(m, SK, { prehash: true, lowS: true }).toCompactRawBytes(),
    { merchant: request.merchant, amount: request.amount, now: NOW },
    (n) => new Uint8Array(n).fill(4),
  );
  assert.ok(issued.ok);
  if (!issued.ok) return;
  const shown = toQr(issued.packet);

  // 3. The till scans it, and takes it.
  const queued: Entry[] = [];
  const first = scan({ text: shown, cache, merchant: MERCHANT, charged, queued, now: NOW });
  assert.equal(first.kind, "take", first.kind === "refused" ? first.reason : first.kind);
  if (first.kind !== "take") return;
  const added = enqueue(() => undefined, first.packet, NOW * 1000);
  assert.equal(added.kind, "added");
  if (added.kind === "added") queued.push(added.entry);

  // 4. The same code shown again is refused, offline, by the till's own memory.
  const replay = scan({ text: shown, cache, merchant: MERCHANT, charged, queued, now: NOW + 5 });
  assert.equal(replay.kind, "refused");

  // And a second, honest payment from the same phone is a new sequence, and taken.
  const again = await pay(
    store,
    async (m) => p256.sign(m, SK, { prehash: true, lowS: true }).toCompactRawBytes(),
    { merchant: request.merchant, amount: request.amount, now: NOW + 10 },
    (n) => new Uint8Array(n).fill(5),
  );
  assert.ok(again.ok);
  if (again.ok) {
    const second = scan({ text: toQr(again.packet), cache, merchant: MERCHANT, charged, queued, now: NOW + 10 });
    assert.equal(second.kind, "take");
  }
});
