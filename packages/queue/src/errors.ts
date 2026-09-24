/**
 * What a failed redemption means.
 *
 * The chain answers a redemption with a number. The queue has to turn that
 * number into one of four decisions, and a wrong one costs money either way.
 * Treat a lost voucher as retryable and the merchant pays fees forever for a
 * sale that will never settle. Give up on one that is only waiting, and the
 * merchant loses a sale the chain would have paid an hour later.
 *
 *   refused   — the voucher can never settle. Stop, and tell the merchant why.
 *   blocked   — chain state says no *now*, and chain state moves. Retry slowly
 *               until the voucher expires.
 *   transient — the network, not the voucher. Retry soon.
 *   held      — the transaction was built wrong, or the chain said something
 *               this code does not know. Retrying repeats the same mistake and
 *               giving up throws away a good voucher, so a person looks.
 *
 * The codes come from `vectors/program-errors-v1.json`, which
 * `programs/nelo_vault/tests/error_vectors.rs` generates from `NeloError`
 * itself. A renumbered program fails that test before it can mislead this one.
 */

/** `NeloError`'s codes, as Anchor numbers them. Checked against the vectors. */
export const PROGRAM_ERROR_CODES = {
  BadVoucherVersion: 6000,
  VaultMismatch: 6001,
  MerchantMismatch: 6002,
  VoucherExpired: 6003,
  AboveFloorLimit: 6004,
  InsufficientCollateral: 6005,
  VaultFrozen: 6006,
  MintMismatch: 6007,
  SequenceTooOld: 6008,
  SequenceTooFarAhead: 6009,
  SequenceAlreadyRedeemed: 6010,
  MissingPrecompileInstruction: 6011,
  MalformedPrecompileInstruction: 6012,
  ExpectedSingleSignature: 6013,
  PrecompileDataNotSelfContained: 6014,
  DeviceKeyMismatch: 6015,
  SignedMessageMismatch: 6016,
  WithdrawNotRequested: 6017,
  WithdrawTimelockActive: 6018,
  NotSameSequence: 6019,
  NotAConflict: 6020,
  BadRiskParams: 6021,
  NotRiskAuthority: 6022,
  ReputationOutOfRange: 6023,
  CooldownTooShort: 6024,
  StakeMintMismatch: 6025,
  InsufficientStake: 6026,
  UnstakeNotRequested: 6027,
  UnstakeCooldownActive: 6028,
  ZeroAmount: 6029,
  Overflow: 6030,
  VaultNotFrozen: 6031,
  NothingToSlash: 6032,
} as const;

export type ProgramErrorName = keyof typeof PROGRAM_ERROR_CODES;

const NAME_OF = new Map<number, ProgramErrorName>(
  Object.entries(PROGRAM_ERROR_CODES).map(([name, code]) => [code, name as ProgramErrorName]),
);

/** Where `redeem_voucher` sits in the transaction; the precompile is 0. */
const REDEEM_IX = 1;
const PRECOMPILE_IX = 0;
/** Anchor's own errors (account constraints and the like) sit below this. */
const PROGRAM_ERROR_OFFSET = 6000;

export type Verdict =
  | {
      kind: "refused";
      reason:
        | "paid-to-someone-else"
        | "expired"
        | "sequence-too-old"
        | "not-the-enrolled-key"
        | "unsupported-version";
      detail: string;
    }
  | {
      kind: "blocked";
      reason: "above-limit" | "collateral-short" | "sequence-ahead" | "fee-payer-unfunded" | "relay-declined";
      detail: string;
    }
  | { kind: "transient"; reason: "blockhash" | "network" | "rpc"; detail: string }
  | {
      kind: "held";
      reason: "precompile-rejected" | "misbuilt" | "unknown";
      detail: string;
    }
  /** The transaction may have landed. Look it up before deciding anything. */
  | { kind: "check"; reason: "already-processed"; detail: string };

/** The program errors `redeem_voucher` can return, and what each one means. */
const BY_NAME: Partial<Record<ProgramErrorName, Verdict>> = {
  // A double spend: this sequence was redeemed first by a different voucher.
  // The queue only concludes this once it knows no attempt of its own landed;
  // see `failed` in queue.ts.
  SequenceAlreadyRedeemed: {
    kind: "refused",
    reason: "paid-to-someone-else",
    detail:
      "Another voucher with this sequence was paid first. The payer spent the same money twice, and this sale was not paid.",
  },
  VoucherExpired: {
    kind: "refused",
    reason: "expired",
    detail: "The voucher expired before it reached the chain.",
  },
  SequenceTooOld: {
    kind: "refused",
    reason: "sequence-too-old",
    detail: "The payer's vault has moved more than 128 vouchers past this one; it can no longer be redeemed.",
  },
  DeviceKeyMismatch: {
    kind: "refused",
    reason: "not-the-enrolled-key",
    detail: "The voucher was not signed by the key this vault has enrolled.",
  },
  BadVoucherVersion: {
    kind: "refused",
    reason: "unsupported-version",
    detail: "The program does not accept this voucher version.",
  },

  // The limit is computed at redemption from a stake revalued at that moment,
  // collateral can be topped up, and the replay window advances as earlier
  // sequences settle. Each of these can turn into a yes.
  AboveFloorLimit: {
    kind: "blocked",
    reason: "above-limit",
    detail: "Above the vault's limit right now. It moves with the stake price and reputation.",
  },
  InsufficientCollateral: {
    kind: "blocked",
    reason: "collateral-short",
    detail: "The payer's vault does not hold enough right now.",
  },
  SequenceTooFarAhead: {
    kind: "blocked",
    reason: "sequence-ahead",
    detail: "Earlier vouchers from this payer have to settle first.",
  },
};

/**
 * `redeem_voucher` derives the vault, merchant and mint accounts from the
 * voucher, and `@nelo/redeem` builds the precompile. These errors therefore
 * mean the transaction was assembled wrongly, not that the voucher is bad.
 */
const MISBUILT: ReadonlySet<ProgramErrorName> = new Set([
  "VaultMismatch",
  "MerchantMismatch",
  "MintMismatch",
  "MissingPrecompileInstruction",
  "MalformedPrecompileInstruction",
  "ExpectedSingleSignature",
  "PrecompileDataNotSelfContained",
  "SignedMessageMismatch",
]);

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

/**
 * Classify a transaction error as the RPC reports it: the `err` of a
 * signature status, or of a failed preflight simulation.
 *
 * Accepts the JSON-RPC shapes — `"BlockhashNotFound"`,
 * `{ InstructionError: [1, { Custom: 6010 }] }` — with `Custom` as a number
 * or a bigint, because kit decodes large integers as bigints.
 */
export function classify(err: unknown): Verdict {
  if (typeof err === "string") {
    switch (err) {
      case "BlockhashNotFound":
        return { kind: "transient", reason: "blockhash", detail: "The blockhash expired before the transaction landed." };
      case "AlreadyProcessed":
        return { kind: "check", reason: "already-processed", detail: "This exact transaction was already processed." };
      case "InsufficientFundsForFee":
      case "AccountNotFound":
        return {
          kind: "blocked",
          reason: "fee-payer-unfunded",
          detail: "The account paying the fee has no SOL. Fund it or route through the relayer.",
        };
      default:
        return { kind: "held", reason: "unknown", detail: `Unrecognised transaction error: ${err}` };
    }
  }

  // A relayer's refusal, before anything was built. It says itself whether
  // waiting could change the answer (a spent daily budget) or not.
  const relay = (err as { RelayDeclined?: { reason?: unknown; retryable?: unknown; conflict?: unknown } } | null)
    ?.RelayDeclined;
  if (relay && typeof relay === "object") {
    const reason = typeof relay.reason === "string" ? relay.reason : "the relayer declined";
    if (relay.conflict === true) {
      // Another voucher at this sequence reached the relayer first: the payer
      // spent the same money twice, and the relayer has reported it.
      return BY_NAME.SequenceAlreadyRedeemed!;
    }
    return relay.retryable === true
      ? { kind: "blocked", reason: "relay-declined", detail: `The relayer will not submit it yet: ${reason}.` }
      : { kind: "held", reason: "unknown", detail: `The relayer refused it: ${reason}.` };
  }

  const ie = (err as { InstructionError?: unknown } | null)?.InstructionError;
  if (Array.isArray(ie) && ie.length === 2) {
    const index = asNumber(ie[0]);
    const inner = ie[1] as { Custom?: unknown } | string;

    if (index === PRECOMPILE_IX) {
      // `@nelo/accept` verified this signature offline and `@nelo/redeem`
      // folds high-S, so the precompile refusing it means one of those is
      // wrong. That is a bug to look at, not a voucher to throw away.
      return {
        kind: "held",
        reason: "precompile-rejected",
        detail: `The signature check refused a voucher that verified offline (${JSON.stringify(inner, bigintSafe)}).`,
      };
    }

    const code = typeof inner === "object" && inner !== null ? asNumber(inner.Custom) : null;
    if (index === REDEEM_IX && code !== null) {
      if (code < PROGRAM_ERROR_OFFSET) {
        return { kind: "held", reason: "misbuilt", detail: `An account check failed (Anchor error ${code}).` };
      }
      const name = NAME_OF.get(code);
      if (name === undefined) {
        return { kind: "held", reason: "unknown", detail: `Unknown program error ${code}.` };
      }
      const known = BY_NAME[name];
      if (known) return known;
      if (MISBUILT.has(name)) {
        return { kind: "held", reason: "misbuilt", detail: `The transaction was built wrongly (${name}).` };
      }
      // Real program errors that redeem_voucher never returns: Overflow, and
      // the withdraw, stake and risk errors. Seeing one means something is
      // very wrong, so a person looks.
      return { kind: "held", reason: "unknown", detail: `redeem_voucher does not return ${name}.` };
    }
  }

  return {
    kind: "held",
    reason: "unknown",
    detail: `Unrecognised transaction error: ${JSON.stringify(err, bigintSafe)}`,
  };
}

function bigintSafe(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
