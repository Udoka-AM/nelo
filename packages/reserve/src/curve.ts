/**
 * A mirror of the on-chain floor-limit curve.
 *
 * The authority is `programs/nelo_vault/src/curve.rs`. This exists so the model
 * can reason about the same limit the chain will actually enforce, and it
 * reproduces the Rust integer semantics — floor division at every step — rather
 * than the smooth formula, because a model that disagrees with the program by a
 * rounding step is a model of something else.
 *
 * `test/curve.test.ts` pins it against the worked values in the Rust tests. If
 * the two ever drift, that test is where it shows up.
 */

const BPS = 10_000;

export interface CurveParams {
  /** Base offline limit, in settlement-token minor units. */
  base: number;
  /** Growth coefficient in bps. */
  kBps: number;
  /** Stake value at which `kBps` applies in full, in minor units. */
  stakeReference: number;
  /** Reputation multiplier in bps. 10_000 is neutral. */
  reputationBps?: number;
  /** Ceiling. */
  hardCap: number;
}

/** Floor of the square root, matching the Rust `isqrt`. */
export const isqrt = (n: number): number => Math.floor(Math.sqrt(n));

/**
 * The offline limit a vault holding `stakeValue` is granted.
 *
 * Integer-floored at each step so it tracks the program exactly.
 */
export function floorLimit(params: CurveParams, stakeValue: number): number {
  const reputationBps = params.reputationBps ?? BPS;
  if (params.stakeReference === 0) return Math.min(params.base, params.hardCap);

  const ratioBps = Math.floor((stakeValue * BPS) / params.stakeReference);
  const sqrtBps = isqrt(ratioBps * BPS);
  const multiplierBps = BPS + Math.floor((params.kBps * sqrtBps) / BPS);
  const limit = Math.floor((params.base * multiplierBps * reputationBps) / (BPS * BPS));

  return Math.min(limit, params.hardCap);
}

/**
 * The smooth derivative `dF/ds`, for the crossover analysis.
 *
 * The stepped integer curve has a derivative of zero almost everywhere and is
 * undefined at the steps, so the continuous form is the only one that answers
 * "does one more dollar of stake raise the limit faster than it covers it?".
 * Above the hard cap the limit stops moving and the derivative is zero.
 *
 *   F(s) = base × (1 + k·√(s/ref))   ⇒   dF/ds = base·k / (2·√(s·ref))
 */
export function limitSlope(params: CurveParams, stakeValue: number): number {
  if (stakeValue <= 0 || params.stakeReference <= 0) return Infinity;
  if (floorLimit(params, stakeValue) >= params.hardCap) return 0;
  const k = params.kBps / BPS;
  return (params.base * k) / (2 * Math.sqrt(stakeValue * params.stakeReference));
}
