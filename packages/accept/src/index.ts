/**
 * Can this merchant take this voucher, right now, with no network?
 *
 * ## The one thing this module is honest about
 *
 * A merchant standing in a dead zone cannot know whether a voucher will settle.
 * They can only know whether it *can*. Those are different questions and
 * conflating them is how a payment product loses a merchant's money.
 *
 * Some facts are decidable offline and stay decided: a signature either came
 * from the enrolled device or it did not, and no later event changes that. The
 * bytes are self-contained and so is the answer.
 *
 * Others depend on chain state the merchant last saw hours ago. Collateral may
 * have been spent on vouchers presented to other merchants. A sequence may have
 * been consumed. A vault may have been frozen. Cached state answers those as of
 * a moment that has passed, and the honest output is not a yes or a no but a yes
 * *with the risk named*.
 *
 * So {@link accept} returns `refuse` only for things that cannot become true
 * later, and otherwise returns `take` carrying every risk the merchant is
 * assuming. A till that renders those risks lets a shopkeeper decide whether a
 * ₦500 sale is worth them. A till that hides them decides on their behalf and
 * gets it wrong at the worst moment.
 *
 * ## What it mirrors
 *
 * `programs/nelo_vault/src/instructions/redeem_voucher.rs`, check for check, in
 * the same order. Where the program and this module disagree, the program is
 * right and this is a bug — the merchant would be accepting something that will
 * be rejected, or refusing money they could have taken.
 *
 * Two of its decisions are easy to get wrong by being too strict:
 *
 *   - **Expiry is `now <= expires_at`.** Valid *at* the boundary, not before
 *     it. A second's disagreement refuses a good voucher.
 *   - **A frozen vault still redeems.** The program says so in a comment that
 *     is worth quoting, because the instinct is to refuse:
 *
 *     > Deliberately no `is_active` check. A freeze blocks the payer's exit,
 *     > not the payees: merchants holding good vouchers must still be able to
 *     > claim against locked collateral.
 *
 *     So a freeze is a risk, not a refusal. It means somebody already
 *     double-spent this vault, which is a real reason to be careful about the
 *     remaining collateral — but refusing outright would cost this merchant a
 *     sale the chain would have honoured.
 */
import {
  decode,
  encodeBase58,
  floorLimit,
  verify,
  type CurveParams,
  type Voucher,
} from "@nelo/voucher";

/** Mirrors `REPLAY_WINDOW` in `programs/nelo_vault/src/constants.rs`. */
export const REPLAY_WINDOW = 128n;

/** Mirrors `VAULT_STATUS_FROZEN`. */
export const VAULT_STATUS_FROZEN = 1;

/**
 * What the merchant knows about a vault, as of the last time they were online.
 *
 * Deliberately the shape of the on-chain `Vault` account rather than something
 * more convenient: the merchant's job is to compute what the chain will
 * compute, and a translation layer between the two is a place for them to
 * drift apart.
 */
export interface Enrolment {
  /** base58. The voucher names this, and a voucher is not bearer. */
  vault: string;
  /** SEC1 compressed, 33 bytes. The only key whose signature counts. */
  devicePubkey: Uint8Array;
  /** Settlement mint, base58. */
  mint: string;
  /** Collateral as of `syncedAt`, in settlement-mint base units. */
  balance: bigint;
  /** Base offline limit before the Trust Stake curve. */
  floorLimit: bigint;
  stake: bigint;
  pendingUnstake: bigint;
  reputationBps: number;
  /** Lowest sequence still tracked by the replay window, as of `syncedAt`. */
  seqBase: bigint;
  /** The 128-slot bitmap, as of `syncedAt`. */
  seqBitmap: bigint;
  /** `VAULT_STATUS_ACTIVE` or `VAULT_STATUS_FROZEN`. */
  status: number;
  /** Unix seconds when this record was last refreshed from the chain. */
  syncedAt: number;
}

/** The risk parameters, as of the last sync. Mirrors `RiskConfig`. */
export interface RiskParams {
  kBps: number;
  stakeReference: bigint;
  hardCap: bigint;
  /** Settlement-mint base units per valuation unit of stake, before haircut. */
  stakePrice: bigint;
  haircutBps: number;
}

export interface Policy {
  /**
   * How old a cached enrolment may be before the merchant is warned, in
   * seconds. Not a refusal: a merchant who has been offline all day still needs
   * to trade, and a stale cache is the ordinary condition of this product
   * rather than an error in it.
   */
  staleAfterSeconds: number;
}

export const DEFAULT_POLICY: Policy = { staleAfterSeconds: 12 * 60 * 60 };

/**
 * A reason the merchant may not settle, even though everything checkable is in
 * order. Every one of these is a fact the merchant could not have known offline.
 */
export type Risk =
  | { kind: "stale-enrolment"; ageSeconds: number }
  /** Cached collateral covers it, but other merchants may have claimed first. */
  | { kind: "collateral-may-be-spent"; cachedBalance: bigint; amount: bigint }
  /** A conflict was reported against this vault: somebody already double-spent. */
  | { kind: "vault-frozen" }
  /**
   * The sequence is free in the cached window, but the window moves on chain
   * and another merchant may hold a voucher at the same one.
   */
  | { kind: "sequence-unconfirmed"; seq: bigint }
  /**
   * The payer's own claim about what is left disagrees with the cached balance.
   * Not proof of fraud — the cache is stale — but it is the shape of it.
   */
  | { kind: "remaining-disputed"; claimed: bigint; expected: bigint };

export type Acceptance =
  | { take: true; voucher: Voucher; amount: bigint; risks: Risk[] }
  | { take: false; reason: string };

const refuse = (reason: string): Acceptance => ({ take: false, reason });

/**
 * Stake value after the haircut, mirroring `curve::stake_value`.
 *
 * `VALUATION_UNIT` is 1e9 in the program. Integer throughout: a floating-point
 * step here would put the merchant and the chain on different sides of a
 * boundary for the vouchers that sit exactly on one.
 */
export const VALUATION_UNIT = 1_000_000_000n;

export function stakeValue(stake: bigint, price: bigint, haircutBps: number): bigint {
  if (stake <= 0n || price <= 0n) return 0n;
  const gross = (stake * price) / VALUATION_UNIT;
  const kept = 10_000n - BigInt(haircutBps);
  if (kept <= 0n) return 0n;
  return (gross * kept) / 10_000n;
}

/** The limit the chain would grant this vault, from what the merchant cached. */
export function limitFor(enrolment: Enrolment, risk: RiskParams): bigint {
  const value = stakeValue(
    enrolment.stake > enrolment.pendingUnstake
      ? enrolment.stake - enrolment.pendingUnstake
      : 0n,
    risk.stakePrice,
    risk.haircutBps,
  );
  const params: CurveParams = {
    base: Number(enrolment.floorLimit),
    kBps: risk.kBps,
    stakeReference: Number(risk.stakeReference),
    reputationBps: enrolment.reputationBps,
    hardCap: Number(risk.hardCap),
  };
  return BigInt(floorLimit(params, Number(value)));
}

/**
 * Is this sequence free, in the window the merchant last saw?
 *
 * Mirrors `consume_sequence`. Three outcomes rather than two, because "too old"
 * and "too far ahead" are permanent while "already set" is only as true as the
 * cache is fresh.
 */
export function sequenceState(
  enrolment: Enrolment,
  seq: bigint,
): "free" | "too-old" | "too-far-ahead" | "already-seen" {
  if (seq < enrolment.seqBase) return "too-old";
  const slot = seq - enrolment.seqBase;
  if (slot >= REPLAY_WINDOW) return "too-far-ahead";
  return (enrolment.seqBitmap >> slot) & 1n ? "already-seen" : "free";
}

export interface AcceptInput {
  /** The 202 bytes off the wire. Decoding is this module's job, not the caller's. */
  bytes: Uint8Array;
  enrolment: Enrolment;
  risk: RiskParams;
  /** Unix seconds, from the merchant's own clock. */
  now: number;
  /**
   * Sequences this merchant has already taken in this offline session, and the
   * `remainingAfter` each one claimed. This is the merchant's own memory, and
   * it is the one part of the replay window they can trust completely.
   */
  seen?: ReadonlyMap<bigint, bigint>;
  policy?: Policy;
}

/**
 * Decide whether to hand over the goods.
 *
 * The order is the program's order, cheapest first, with the signature check
 * before anything that depends on cached state — a forged voucher should be
 * refused for being forged, not for some incidental disagreement about balance.
 */
export function accept(input: AcceptInput): Acceptance {
  const policy = input.policy ?? DEFAULT_POLICY;
  const { enrolment, risk, now } = input;

  // Version and length have exactly one enforcement point, and this is not it:
  // `decode` is the only thing that knows the wire format.
  let voucher: Voucher;
  try {
    voucher = decode(input.bytes);
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }

  if (encodeBase58(voucher.vault) !== enrolment.vault) {
    return refuse("this voucher names a different vault");
  }

  // `now <= expires_at` on chain. Refusing at equality would reject a voucher
  // the program would have honoured.
  if (BigInt(now) > voucher.expiresAt) {
    return refuse("this voucher has expired");
  }

  if (voucher.amount <= 0n) return refuse("this voucher carries no amount");

  const limit = limitFor(enrolment, risk);
  if (voucher.amount > limit) {
    return refuse(`above this vault's offline limit of ${limit}`);
  }

  // The signature is the one thing here that no later event can change, and the
  // only thing that distinguishes a payer from someone holding their phone.
  if (!sameKey(voucher.devicePubkey, enrolment.devicePubkey)) {
    return refuse("signed by a key this vault has not enrolled");
  }
  if (!verify(voucher)) {
    return refuse("the signature does not verify");
  }

  // The merchant's own memory is the part of the replay window they can trust.
  const seen = input.seen;
  if (seen?.has(voucher.seq)) {
    return refuse(`sequence ${voucher.seq} was already presented to this till`);
  }

  switch (sequenceState(enrolment, voucher.seq)) {
    case "too-old":
      return refuse(`sequence ${voucher.seq} is below the replay window`);
    case "too-far-ahead":
      return refuse(`sequence ${voucher.seq} is beyond the replay window`);
    case "already-seen":
      return refuse(`sequence ${voucher.seq} was already redeemed`);
    case "free":
      break;
  }

  // Everything above is decided. Everything below is a risk with a name.
  const risks: Risk[] = [];

  const age = now - enrolment.syncedAt;
  if (age > policy.staleAfterSeconds) {
    risks.push({ kind: "stale-enrolment", ageSeconds: age });
  }
  if (enrolment.status === VAULT_STATUS_FROZEN) {
    risks.push({ kind: "vault-frozen" });
  }
  if (voucher.amount > enrolment.balance) {
    // Not a refusal: the cached balance is a floor on nothing. The payer may
    // have deposited since. But it is the merchant's money at stake.
    risks.push({
      kind: "collateral-may-be-spent",
      cachedBalance: enrolment.balance,
      amount: voucher.amount,
    });
  }
  risks.push({ kind: "sequence-unconfirmed", seq: voucher.seq });

  // The payer signs what they claim is left. Across two vouchers in one session
  // that claim has to be self-consistent, and this merchant can check it even
  // though the chain's balance is unknown to them.
  const expected = expectedRemaining(seen, voucher);
  if (expected !== null && voucher.remainingAfter !== expected) {
    risks.push({
      kind: "remaining-disputed",
      claimed: voucher.remainingAfter,
      expected,
    });
  }

  return { take: true, voucher, amount: voucher.amount, risks };
}

/**
 * What `remainingAfter` should read, given the last voucher this till took.
 *
 * Only the immediately preceding sequence is checkable: with a gap, vouchers
 * went to other merchants and this till has no idea what they were worth.
 * Returning null for that case is the difference between a check and a guess.
 */
function expectedRemaining(
  seen: ReadonlyMap<bigint, bigint> | undefined,
  voucher: Voucher,
): bigint | null {
  if (!seen) return null;
  const previous = seen.get(voucher.seq - 1n);
  if (previous === undefined) return null;
  const expected = previous - voucher.amount;
  return expected < 0n ? 0n : expected;
}

function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

