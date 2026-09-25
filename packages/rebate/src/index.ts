/**
 * The merchant's rebate election: cash or SKR.
 *
 * Every settled sale accrues a rebate (10 bps, `REBATE_BPS` in
 * `services/settle`). Each month the merchant chooses how it is paid. Cash is
 * the default and stays the default: most small merchants want money, not a
 * token. SKR pays more, already staked, which also raises their offline
 * limit. See docs/BUILD.md §5.
 *
 * Three rules live here, under test, because each is a way to get it wrong:
 *
 * 1. **SKR needs the disclosure, acknowledged.** Choosing SKR is accepting
 *    price risk on a volatile asset. The election refuses SKR unless the
 *    merchant acknowledged the disclosure as it currently reads. Changing the
 *    wording bumps its version, and an old acknowledgement no longer counts.
 * 2. **A choice applies from next month.** Choosing after seeing this month's
 *    SKR price would let a merchant pick the winner in hindsight, at the
 *    platform's cost. The month in progress keeps what it started with.
 * 3. **The premium is labelled until it is priced.** The multiplier must be
 *    derived from the capital stake saves (`@nelo/reserve`'s
 *    `premiumCeiling`), not picked. Until it is, it is shown as illustrative.
 */

export type Choice = "cash" | "skr";

/**
 * The one plain sentence, shown at the point of election. Change the words,
 * change the version: an acknowledgement is of a particular text.
 */
export const DISCLOSURE = {
  version: 1,
  text:
    "SKR is a volatile token: if its price falls, the rebate you take in SKR can end up worth less than the cash you gave up for it.",
} as const;

/** Mirrors `REBATE_BPS` in services/settle: 20% of the platform fee. */
export const REBATE_BPS = 10n;

export interface Premium {
  /** Paid in SKR per unit of cash rebate, in basis points: 15_000 is 1.5×. */
  multiplierBps: bigint;
  /** True until the multiplier is derived from the reserve model. */
  illustrative: boolean;
}

/** docs/BUILD.md §5's placeholder, labelled as one. */
export const ILLUSTRATIVE_PREMIUM: Premium = { multiplierBps: 15_000n, illustrative: true };

export interface Election {
  choice: Choice;
  /** First month it applies to, `YYYY-MM`. */
  from: string;
  /** Unix milliseconds. */
  madeAt: number;
  /** The disclosure version acknowledged. SKR only. */
  disclosure?: number;
}

/** Every election made, oldest first. No history means cash. */
export interface Elections {
  history: Election[];
}

export const noElections = (): Elections => ({ history: [] });

/** The merchant's month, `YYYY-MM`, on their own clock. */
export function monthOf(atMs: number, tzOffsetMinutes: number): string {
  const d = new Date(atMs + tzOffsetMinutes * 60_000);
  return `${d.getUTCFullYear()}-${`${d.getUTCMonth() + 1}`.padStart(2, "0")}`;
}

export function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${`${m + 1}`.padStart(2, "0")}`;
}

/** What applies to `month`. */
export function choiceFor(e: Elections, month: string): Choice {
  let choice: Choice = "cash";
  for (const x of e.history) if (x.from <= month) choice = x.choice;
  return choice;
}

export type Elected =
  | { ok: true; elections: Elections; from: string }
  | { ok: false; reason: string };

/**
 * Choose how rebates are paid from next month. Choosing again before next
 * month starts replaces the earlier choice for it.
 */
export function elect(
  e: Elections,
  choice: Choice,
  opts: { now: number; tzOffsetMinutes: number; acknowledged?: number },
): Elected {
  if (choice === "skr" && opts.acknowledged !== DISCLOSURE.version) {
    return { ok: false, reason: "Taking the rebate in SKR needs the price-risk notice read and accepted first." };
  }
  const from = nextMonth(monthOf(opts.now, opts.tzOffsetMinutes));
  const kept = e.history.filter((x) => x.from < from);
  const election: Election = {
    choice,
    from,
    madeAt: opts.now,
    ...(choice === "skr" ? { disclosure: DISCLOSURE.version } : {}),
  };
  // Choosing what already applies then is not a change worth recording.
  const history = choiceFor({ history: kept }, from) === choice ? kept : [...kept, election];
  return { ok: true, elections: { history }, from };
}

export interface Quote {
  /** The rebate in cash, in token base units. Rounded down. */
  cash: bigint;
  /** The same rebate's value if taken in SKR, at the premium. Rounded down. */
  skrValue: bigint;
  premium: Premium;
}

/** What `volume` of settled sales earns, either way. */
export function quote(volume: bigint, premium: Premium = ILLUSTRATIVE_PREMIUM): Quote {
  if (volume < 0n) throw new RangeError("volume cannot be negative");
  const cash = (volume * REBATE_BPS) / 10_000n;
  return { cash, skrValue: (cash * premium.multiplierBps) / 10_000n, premium };
}

/** "1.5×". */
export function formatMultiplier(bps: bigint): string {
  const whole = bps / 10_000n;
  const frac = (bps % 10_000n).toString().padStart(4, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""}×`;
}

/** For storage: JSON in, JSON out, and anything malformed is no elections. */
export function fromJson(text: string | null): Elections {
  if (!text) return noElections();
  try {
    const parsed = JSON.parse(text) as Elections;
    const ok =
      Array.isArray(parsed.history) &&
      parsed.history.every(
        (x) =>
          (x.choice === "cash" || x.choice === "skr") &&
          /^\d{4}-\d{2}$/.test(x.from) &&
          typeof x.madeAt === "number" &&
          (x.choice === "cash" || typeof x.disclosure === "number"),
      );
    return ok ? parsed : noElections();
  } catch {
    return noElections();
  }
}
