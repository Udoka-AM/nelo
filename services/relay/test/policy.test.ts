/**
 * The sponsorship policy. Every refusal here is money the relayer keeps, so
 * each one is tested for firing *and* for firing for the right reason — a
 * refusal that happens to be correct by accident is the failure mode this
 * repository keeps finding.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { p256 } from "@noble/curves/p256";
import { encode, signedMessage, VOUCHER_LEN, type Voucher } from "@nelo/voucher";
import {
  ATA_RENT_LAMPORTS,
  SIGNATURE_FEE_LAMPORTS,
  decide,
  type Limits,
  type Spent,
} from "../src/policy.ts";

const NOW = 1_800_000_000;

/** Deterministic device key, so a failure reproduces exactly. */
const PRIVATE_KEY = new Uint8Array(32).fill(7);
const DEVICE_PUBKEY = p256.getPublicKey(PRIVATE_KEY, true);

/** A real signature over the real 105 bytes — not a fixture. */
function sign(fields: Omit<Voucher, "signature" | "devicePubkey">): Voucher {
  const message = signedMessage(fields);
  // Low-S, because a high-S signature verifies here and is refused on chain.
  const signature = p256.sign(message, PRIVATE_KEY, { prehash: true, lowS: true });
  return { ...fields, signature: signature.toBytes("compact"), devicePubkey: DEVICE_PUBKEY };
}

function voucher(overrides: Partial<Voucher> = {}): Voucher {
  const base = {
    version: 1,
    vault: new Uint8Array(32).fill(1),
    seq: 1n,
    amount: 5_000_000n,
    remainingAfter: 45_000_000n,
    merchant: new Uint8Array(32).fill(2),
    expiresAt: BigInt(NOW + 3600),
    salt: new Uint8Array(8).fill(3),
  };
  const { signature, devicePubkey, ...fields } = overrides;
  const signed = sign({ ...base, ...fields });
  return { ...signed, ...(signature ? { signature } : {}), ...(devicePubkey ? { devicePubkey } : {}) };
}

const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

const limits = (over: Partial<Limits> = {}): Limits => ({
  budgetLamports: 1_000_000_000,
  maxPerVault: 10,
  allowedMints: [MINT],
  sponsorNewAccounts: false,
  ...over,
});

const spent = (over: Partial<Spent> = {}): Spent => ({ lamports: 0, forThisVault: 0, ...over });

const request = (
  over: { merchantTokenExists?: boolean; mint?: string; voucher?: Voucher; bytes?: Uint8Array } = {},
) => ({
  voucherBytes: over.bytes ?? encode(over.voucher ?? voucher()),
  merchantTokenExists: over.merchantTokenExists ?? true,
  mint: over.mint ?? MINT,
});

// ------------------------------------------------------- the ordinary case ---

test("an ordinary redemption for an existing merchant costs one signature", () => {
  const d = decide(request(), limits(), spent(), NOW);
  assert.equal(d.sponsor, true);
  if (d.sponsor) {
    assert.equal(d.costLamports, SIGNATURE_FEE_LAMPORTS);
    assert.equal(d.createsAccount, false);
  }
});

// ------------------------------------------------------------ rent, priced ---

/**
 * The number this whole module exists for. If it ever stops being roughly four
 * hundred, the default in `Limits` deserves rethinking rather than keeping.
 */
test("funding a token account costs four hundred times a signature", () => {
  assert.equal(ATA_RENT_LAMPORTS, 2_039_280);
  const ratio = ATA_RENT_LAMPORTS / SIGNATURE_FEE_LAMPORTS;
  assert.ok(ratio > 400 && ratio < 410, `ratio was ${ratio}`);
});

test("a merchant with no token account is refused by default", () => {
  const d = decide(request({ merchantTokenExists: false }), limits(), spent(), NOW);
  assert.equal(d.sponsor, false);
  if (!d.sponsor) assert.match(d.reason, /no token account/);
});

test("turning it on prices the rent in, rather than hiding it", () => {
  const d = decide(
    request({ merchantTokenExists: false }),
    limits({ sponsorNewAccounts: true }),
    spent(),
    NOW,
  );
  assert.equal(d.sponsor, true);
  if (d.sponsor) {
    assert.equal(d.costLamports, SIGNATURE_FEE_LAMPORTS + ATA_RENT_LAMPORTS);
    assert.equal(d.createsAccount, true);
  }
});

// ------------------------------------------- refuse before spending, not after ---

/**
 * The check that justifies doing any of this off chain. A forged voucher
 * submitted on chain still costs the relayer a fee to be told no.
 */
test("a forged signature is refused, and it is the signature that catches it", () => {
  const forged = voucher();
  // Flip one bit of the signature. Everything else is untouched, so any
  // refusal must come from verification and not from a shape check.
  forged.signature = Uint8Array.from(forged.signature);
  forged.signature[0] ^= 0x01;

  const d = decide(request({ voucher: forged }), limits(), spent(), NOW);
  assert.equal(d.sponsor, false);
  if (!d.sponsor) assert.match(d.reason, /signature does not verify/);
});

test("a voucher re-signed for a different amount does not verify", () => {
  // The tamper an attacker actually wants: keep the signature, change the
  // amount. The signed message covers it, so verification fails.
  const tampered = { ...voucher(), amount: 500_000_000n };
  const d = decide(request({ voucher: tampered }), limits(), spent(), NOW);
  assert.equal(d.sponsor, false);
  if (!d.sponsor) assert.match(d.reason, /signature does not verify/);
});

test("an expired voucher is refused before a lamport moves", () => {
  const stale = voucher({ expiresAt: BigInt(NOW - 1) });
  const d = decide(request({ voucher: stale }), limits(), spent(), NOW);
  assert.equal(d.sponsor, false);
  if (!d.sponsor) assert.match(d.reason, /expired/);
});

test("expiry matches the program at the boundary", () => {
  // redeem_voucher requires `now <= expires_at`: a voucher is still good in its
  // expiry second. The earlier version of this test asserted the opposite and
  // claimed the program agreed; it did not, and the relayer was refusing
  // vouchers the chain would have paid.
  const atBoundary = voucher({ expiresAt: BigInt(NOW) });
  assert.equal(decide(request({ voucher: atBoundary }), limits(), spent(), NOW).sponsor, true);

  const oneEarlier = voucher({ expiresAt: BigInt(NOW - 1) });
  const d = decide(request({ voucher: oneEarlier }), limits(), spent(), NOW);
  assert.equal(d.sponsor, false);
  if (!d.sponsor) assert.match(d.reason, /expired/);
});

/**
 * Version and length are `decode`'s to enforce — it is the only thing that
 * does, which is why this module takes bytes rather than a `Voucher`. An
 * earlier draft duplicated the version check here and the test could not even
 * construct a failing case: `signedMessage` refuses to sign an unknown
 * version, so the branch was unreachable. Driving it through the bytes is what
 * makes it a real check.
 */
test("a version the decoder does not know is refused, not thrown", () => {
  const bytes = encode(voucher());
  bytes[0] = 2;
  const d = decide(request({ bytes }), limits(), spent(), NOW);
  assert.equal(d.sponsor, false);
  if (!d.sponsor) assert.match(d.reason, /version 2/);
});

test("a truncated packet is a refusal, not an exception", () => {
  const short = encode(voucher()).slice(0, VOUCHER_LEN - 1);
  const d = decide(request({ bytes: short }), limits(), spent(), NOW);
  assert.equal(d.sponsor, false);
  if (!d.sponsor) assert.match(d.reason, /202 bytes/);
});

test("a successful decision hands back the decoded voucher", () => {
  const d = decide(request(), limits(), spent(), NOW);
  assert.equal(d.sponsor, true);
  // So the caller builds the transaction from what was actually verified,
  // rather than decoding the bytes a second time and hoping they agree.
  if (d.sponsor) assert.equal(d.voucher.amount, 5_000_000n);
});

test("a zero-amount voucher buys nothing and is not sponsored", () => {
  const d = decide(request({ voucher: voucher({ amount: 0n }) }), limits(), spent(), NOW);
  assert.equal(d.sponsor, false);
  if (!d.sponsor) assert.match(d.reason, /no amount/);
});

// ------------------------------------------------------------------ limits ---

test("an unsponsored mint is refused by name", () => {
  const other = "So11111111111111111111111111111111111111112";
  const d = decide(request({ mint: other }), limits(), spent(), NOW);
  assert.equal(d.sponsor, false);
  if (!d.sponsor) assert.match(d.reason, /not sponsored/);
});

test("one vault cannot take the whole window", () => {
  const d = decide(request(), limits({ maxPerVault: 3 }), spent({ forThisVault: 3 }), NOW);
  assert.equal(d.sponsor, false);
  if (!d.sponsor) assert.match(d.reason, /sponsorship limit/);
});

test("the budget is checked against this request's cost, not against zero", () => {
  // One signature short of the ceiling: an ordinary redemption still fits.
  const nearly = limits({ budgetLamports: 100_000 });
  assert.equal(
    decide(request(), nearly, spent({ lamports: 95_000 }), NOW).sponsor,
    true,
    "5,000 into a 5,000 gap should fit",
  );

  // The same gap cannot absorb a rent-funding request.
  const d = decide(
    request({ merchantTokenExists: false }),
    limits({ budgetLamports: 100_000, sponsorNewAccounts: true }),
    spent({ lamports: 95_000 }),
    NOW,
  );
  assert.equal(d.sponsor, false);
  if (!d.sponsor) assert.match(d.reason, /budget/);
});

test("the budget is a ceiling, not a floor", () => {
  const exact = limits({ budgetLamports: 10_000 });
  assert.equal(decide(request(), exact, spent({ lamports: 5_000 }), NOW).sponsor, true);
  assert.equal(decide(request(), exact, spent({ lamports: 5_001 }), NOW).sponsor, false);
});

// ----------------------------------------------------------------- hygiene ---

test("the decision never mutates what it was given", () => {
  const req = request();
  const lim = limits();
  const sp = spent();
  const before = structuredClone({ req, lim, sp });
  decide(req, lim, sp, NOW);
  assert.deepEqual({ req, lim, sp }, before);
});

test("every refusal carries a reason a person can act on", () => {
  const refusals = [
    decide(request({ mint: "x" }), limits(), spent(), NOW),
    decide(request({ voucher: voucher({ expiresAt: 0n }) }), limits(), spent(), NOW),
    decide(request({ merchantTokenExists: false }), limits(), spent(), NOW),
    decide(request(), limits({ maxPerVault: 0 }), spent(), NOW),
    decide(request(), limits({ budgetLamports: 0 }), spent(), NOW),
  ];
  for (const d of refusals) {
    assert.equal(d.sponsor, false);
    if (!d.sponsor) assert.ok(d.reason.length > 10, `thin reason: "${d.reason}"`);
  }
});
