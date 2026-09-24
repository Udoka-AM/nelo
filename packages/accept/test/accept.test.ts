/**
 * Offline acceptance.
 *
 * Two kinds of test here, and the split is the point of the module.
 *
 * The **refusals** are things the merchant can settle with no network, and they
 * are tested for firing *and* for firing for the right reason — a refusal that
 * happens to be correct by accident is the failure this repository keeps
 * finding.
 *
 * The **risks** are the opposite: cases where the honest answer is yes, with
 * something named. Each of those tests asserts that the voucher is still taken,
 * because a module that refuses when it is merely uncertain costs a merchant
 * real sales in a dead zone, which is the exact situation this product exists
 * for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { p256 } from "@noble/curves/p256";
import { encode, encodeBase58, signedMessage, type Voucher } from "@nelo/voucher";
import {
  DEFAULT_POLICY,
  VAULT_STATUS_FROZEN,
  accept,
  limitFor,
  sequenceState,
  stakeValue,
  type Enrolment,
  type Risk,
  type RiskParams,
} from "../src/index.ts";

const NOW = 1_800_000_000;

const PRIVATE_KEY = new Uint8Array(32).fill(7);
const DEVICE_PUBKEY = p256.getPublicKey(PRIVATE_KEY, true);
const OTHER_PRIVATE_KEY = new Uint8Array(32).fill(9);
const OTHER_KEY = p256.getPublicKey(OTHER_PRIVATE_KEY, true);

const VAULT_BYTES = new Uint8Array(32).fill(1);
const VAULT = encodeBase58(VAULT_BYTES);

function sign(
  fields: Omit<Voucher, "signature" | "devicePubkey">,
  key: Uint8Array = PRIVATE_KEY,
): Voucher {
  const signature = p256.sign(signedMessage(fields), key, { prehash: true, lowS: true });
  return {
    ...fields,
    signature: signature.toBytes("compact"),
    devicePubkey: p256.getPublicKey(key, true),
  };
}

function voucher(over: Partial<Omit<Voucher, "signature" | "devicePubkey">> = {}): Voucher {
  return sign({
    version: 1,
    vault: VAULT_BYTES,
    seq: 5n,
    amount: 5_000_000n,
    remainingAfter: 45_000_000n,
    merchant: new Uint8Array(32).fill(2),
    expiresAt: BigInt(NOW + 3600),
    salt: new Uint8Array(8).fill(3),
    ...over,
  });
}

const enrolment = (over: Partial<Enrolment> = {}): Enrolment => ({
  vault: VAULT,
  devicePubkey: DEVICE_PUBKEY,
  mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  balance: 50_000_000n,
  floorLimit: 50_000_000n,
  stake: 0n,
  pendingUnstake: 0n,
  reputationBps: 10_000,
  seqBase: 0n,
  seqBitmap: 0n,
  status: 0,
  syncedAt: NOW - 60,
  ...over,
});

const risk = (over: Partial<RiskParams> = {}): RiskParams => ({
  kBps: 10_000,
  stakeReference: 1_000_000_000n,
  hardCap: 500_000_000n,
  stakePrice: 0n,
  haircutBps: 2_000,
  ...over,
});

const run = (over: Partial<Parameters<typeof accept>[0]> = {}) =>
  accept({ bytes: encode(voucher()), enrolment: enrolment(), risk: risk(), now: NOW, ...over });

const kinds = (risks: Risk[]) => risks.map((r) => r.kind).sort();

// ------------------------------------------------------- the ordinary sale ---

test("a good voucher against a fresh enrolment is taken", () => {
  const decision = run();
  assert.equal(decision.take, true);
  if (decision.take) assert.equal(decision.amount, 5_000_000n);
});

/**
 * Even the happy path carries one risk, and saying so is the module's job. The
 * merchant cannot know that another till is not holding a voucher at the same
 * sequence — that is what the chain's replay window settles, later.
 */
test("every acceptance names the sequence as unconfirmed, because it is", () => {
  const decision = run();
  assert.equal(decision.take, true);
  if (decision.take) assert.deepEqual(kinds(decision.risks), ["sequence-unconfirmed"]);
});

// ------------------------------------------ refusals: settled with no network ---

test("a forged signature is refused, and it is verification that catches it", () => {
  const forged = voucher();
  forged.signature = Uint8Array.from(forged.signature);
  forged.signature[0] ^= 0x01;
  const decision = accept({
    bytes: encode(forged),
    enrolment: enrolment(),
    risk: risk(),
    now: NOW,
  });
  assert.equal(decision.take, false);
  if (!decision.take) assert.match(decision.reason, /signature does not verify/);
});

test("a real signature from an unenrolled device is refused", () => {
  // Cryptographically perfect and completely worthless: this is somebody else's
  // secure element. Verifying it would pass, which is why the key is checked
  // against the enrolment first.
  const impostor = sign(
    {
      version: 1,
      vault: VAULT_BYTES,
      seq: 5n,
      amount: 5_000_000n,
      remainingAfter: 45_000_000n,
      merchant: new Uint8Array(32).fill(2),
      expiresAt: BigInt(NOW + 3600),
      salt: new Uint8Array(8).fill(3),
    },
    OTHER_PRIVATE_KEY,
  );
  assert.deepEqual(impostor.devicePubkey, OTHER_KEY, "the fixture must use the other key");

  const decision = run({ bytes: encode(impostor) });
  assert.equal(decision.take, false);
  if (!decision.take) assert.match(decision.reason, /has not enrolled/);
});

test("a voucher for another vault is refused", () => {
  const other = enrolment({ vault: encodeBase58(new Uint8Array(32).fill(4)) });
  const decision = run({ enrolment: other });
  assert.equal(decision.take, false);
  if (!decision.take) assert.match(decision.reason, /different vault/);
});

/**
 * The boundary the program defines as **valid**: `require!(now <= expires_at)`.
 * Refusing here would turn down money the chain would have paid.
 */
test("expiry matches the program exactly — valid at the boundary", () => {
  const atBoundary = run({ bytes: encode(voucher({ expiresAt: BigInt(NOW) })) });
  assert.equal(atBoundary.take, true, "now == expiresAt is still valid on chain");

  const past = run({ bytes: encode(voucher({ expiresAt: BigInt(NOW - 1) })) });
  assert.equal(past.take, false);
  if (!past.take) assert.match(past.reason, /expired/);
});

test("an amount above the vault's offline limit is refused, with the limit named", () => {
  const decision = run({ bytes: encode(voucher({ amount: 60_000_000n })) });
  assert.equal(decision.take, false);
  if (!decision.take) assert.match(decision.reason, /offline limit of 50000000/);
});

test("a truncated packet is a refusal, not an exception", () => {
  const decision = run({ bytes: encode(voucher()).slice(0, 201) });
  assert.equal(decision.take, false);
  if (!decision.take) assert.match(decision.reason, /202 bytes/);
});

// ---------------------------------------------------- the replay window ---

test("a sequence below the window is refused permanently", () => {
  const decision = run({ enrolment: enrolment({ seqBase: 10n }) });
  assert.equal(decision.take, false);
  if (!decision.take) assert.match(decision.reason, /below the replay window/);
});

test("a sequence beyond the window is refused permanently", () => {
  const decision = run({ bytes: encode(voucher({ seq: 200n })) });
  assert.equal(decision.take, false);
  if (!decision.take) assert.match(decision.reason, /beyond the replay window/);
});

test("a sequence the cached bitmap has already set is refused", () => {
  const decision = run({ enrolment: enrolment({ seqBitmap: 1n << 5n }) });
  assert.equal(decision.take, false);
  if (!decision.take) assert.match(decision.reason, /already redeemed/);
});

/**
 * The strongest refusal available offline. The chain's window is stale, but
 * this till's own memory is not: if it took sequence 5 ten minutes ago, a
 * second voucher at 5 is a double-spend it can prove without a network.
 */
test("a sequence this till already took is refused on the till's own memory", () => {
  const decision = run({ seen: new Map([[5n, 45_000_000n]]) });
  assert.equal(decision.take, false);
  if (!decision.take) assert.match(decision.reason, /already presented to this till/);
});

test("the window boundary is exact", () => {
  assert.equal(sequenceState(enrolment(), 127n), "free");
  assert.equal(sequenceState(enrolment(), 128n), "too-far-ahead");
  assert.equal(sequenceState(enrolment({ seqBase: 1n }), 0n), "too-old");
});

// ------------------------------------------------ risks: taken, and named ---

/**
 * The instinct is to refuse a frozen vault, and the program says not to:
 *
 *   > A freeze blocks the payer's exit, not the payees: merchants holding good
 *   > vouchers must still be able to claim against locked collateral.
 *
 * Refusing here would cost this merchant a sale the chain would have honoured.
 */
test("a frozen vault is a risk, not a refusal", () => {
  const decision = run({ enrolment: enrolment({ status: VAULT_STATUS_FROZEN }) });
  assert.equal(decision.take, true, "the program redeems frozen vaults; so must we");
  if (decision.take) assert.ok(kinds(decision.risks).includes("vault-frozen"));
});

test("an amount above the cached balance is a risk, not a refusal", () => {
  // The cache is stale — the payer may have deposited since. But it is the
  // merchant's money, so they are told.
  const decision = run({ enrolment: enrolment({ balance: 1_000_000n }) });
  assert.equal(decision.take, true);
  if (decision.take) {
    const found = decision.risks.find((r) => r.kind === "collateral-may-be-spent");
    assert.ok(found);
    if (found?.kind === "collateral-may-be-spent") {
      assert.equal(found.cachedBalance, 1_000_000n);
      assert.equal(found.amount, 5_000_000n);
    }
  }
});

test("a stale enrolment is a risk, not a refusal — offline all day is the normal case", () => {
  const old = enrolment({ syncedAt: NOW - DEFAULT_POLICY.staleAfterSeconds - 1 });
  const decision = run({ enrolment: old });
  assert.equal(decision.take, true);
  if (decision.take) assert.ok(kinds(decision.risks).includes("stale-enrolment"));
});

test("a fresh enrolment raises no staleness risk", () => {
  const decision = run();
  assert.equal(decision.take, true);
  if (decision.take) assert.ok(!kinds(decision.risks).includes("stale-enrolment"));
});

// ------------------------------------------------------- remaining_after ---

/**
 * The payer signs what they claim is left. Across two consecutive vouchers to
 * the same till that claim has to add up, and this merchant can check it
 * without knowing the chain's balance at all.
 */
test("an inconsistent remaining_after is flagged against the previous voucher", () => {
  // Took seq 4 leaving 45,000,000. Seq 5 spends 5,000,000, so 40,000,000 is
  // the only honest claim. This one says the balance went up.
  const decision = run({
    bytes: encode(voucher({ seq: 5n, amount: 5_000_000n, remainingAfter: 48_000_000n })),
    seen: new Map([[4n, 45_000_000n]]),
  });
  assert.equal(decision.take, true, "not proof of fraud — but the merchant is told");
  if (decision.take) {
    const found = decision.risks.find((r) => r.kind === "remaining-disputed");
    assert.ok(found, "an impossible remaining_after went unflagged");
    if (found?.kind === "remaining-disputed") {
      assert.equal(found.claimed, 48_000_000n);
      assert.equal(found.expected, 40_000_000n);
    }
  }
});

test("a consistent remaining_after is not flagged", () => {
  const decision = run({
    bytes: encode(voucher({ seq: 5n, amount: 5_000_000n, remainingAfter: 40_000_000n })),
    seen: new Map([[4n, 45_000_000n]]),
  });
  assert.equal(decision.take, true);
  if (decision.take) assert.ok(!kinds(decision.risks).includes("remaining-disputed"));
});

/**
 * With a gap, vouchers went to other merchants and this till has no idea what
 * they were worth. Flagging that would be inventing a finding, and a warning
 * that fires on ordinary trading is a warning nobody reads.
 */
test("a gap in sequences is not treated as a dispute", () => {
  const decision = run({
    bytes: encode(voucher({ seq: 9n, remainingAfter: 1n })),
    seen: new Map([[4n, 45_000_000n]]),
  });
  assert.equal(decision.take, true);
  if (decision.take) assert.ok(!kinds(decision.risks).includes("remaining-disputed"));
});

// ------------------------------------------------------------- the curve ---

test("with no stake the limit is exactly the enrolled floor", () => {
  assert.equal(limitFor(enrolment(), risk()), 50_000_000n);
});

test("stake lifts the limit, and the haircut is applied before the curve", () => {
  const staked = enrolment({ stake: 2_000_000_000n });
  const withPrice = risk({ stakePrice: 1_000_000_000n });
  assert.ok(limitFor(staked, withPrice) > 50_000_000n);
  // 20% haircut: 2 units of stake at 1.0 is $2, kept as $1.60.
  assert.equal(stakeValue(2_000_000_000n, 1_000_000_000n, 2_000), 1_600_000_000n);
});

/**
 * Requested-but-uncollected stake stops counting the moment it is requested.
 * Otherwise a payer opens an unstake request, keeps trading at the limit that
 * stake was buying, and collects at the end of the cooldown.
 */
test("pending unstake is out of the curve immediately", () => {
  const withPrice = risk({ stakePrice: 1_000_000_000n });
  const staked = enrolment({ stake: 2_000_000_000n });

  // A PARTIAL request, deliberately. An earlier version of this test used
  // stake == pendingUnstake, which takes the "no stake at all" branch and never
  // exercises the subtraction — it passed against a build that ignored pending
  // unstake entirely. Half out has to land strictly between the two.
  const half = enrolment({ stake: 2_000_000_000n, pendingUnstake: 1_000_000_000n });
  const oneUnit = enrolment({ stake: 1_000_000_000n });
  assert.equal(
    limitFor(half, withPrice),
    limitFor(oneUnit, withPrice),
    "two staked with one requested out must price as one staked",
  );
  assert.ok(limitFor(half, withPrice) < limitFor(staked, withPrice));
  assert.ok(limitFor(half, withPrice) > 50_000_000n);

  // And all of it out is the floor again.
  const leaving = enrolment({ stake: 2_000_000_000n, pendingUnstake: 2_000_000_000n });
  assert.equal(limitFor(leaving, withPrice), 50_000_000n);
});

test("the hard cap binds", () => {
  const huge = enrolment({ stake: 10_000_000_000_000n });
  const capped = risk({ stakePrice: 1_000_000_000n, hardCap: 60_000_000n });
  assert.equal(limitFor(huge, capped), 60_000_000n);
});

// ----------------------------------------------------------------- hygiene ---

test("the decision never mutates what it was given", () => {
  const input = { bytes: encode(voucher()), enrolment: enrolment(), risk: risk(), now: NOW };
  const before = structuredClone({ e: input.enrolment, r: input.risk, b: input.bytes });
  accept(input);
  assert.deepEqual({ e: input.enrolment, r: input.risk, b: input.bytes }, before);
});

test("every refusal carries a reason a person can act on", () => {
  const refusals = [
    run({ bytes: encode(voucher({ expiresAt: 0n })) }),
    run({ bytes: encode(voucher({ amount: 60_000_000n })) }),
    run({ enrolment: enrolment({ seqBase: 10n }) }),
    run({ enrolment: enrolment({ vault: encodeBase58(new Uint8Array(32).fill(4)) }) }),
  ];
  for (const decision of refusals) {
    assert.equal(decision.take, false);
    if (!decision.take) assert.ok(decision.reason.length > 10, `thin: "${decision.reason}"`);
  }
});
