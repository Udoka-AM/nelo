//! The floor-limit curve.
//!
//! `offline_limit = min(base × (1 + k·√(stake_value)) × reputation, hard_cap)`
//!
//! Three properties, and each one is a test below rather than a comment:
//!
//!  - **Sublinear.** Doubling the stake must raise the limit by *less* than
//!    double, or trust is simply bought and the collateral model is a price
//!    list. This is the whole reason for the square root.
//!  - **Capped.** No merchant creates unbounded exposure, whatever they stake
//!    and whatever reputation the risk authority publishes.
//!  - **Saturating.** Past the point where the limit covers the merchant's
//!    largest realistic basket, more collateral buys nothing. That is correct
//!    behaviour for collateral — and it is exactly why the earning side of the
//!    Trust Stake has to be a separate mechanism. See docs/BUILD.md §5.
//!
//! No floats. Everything here is integer fixed-point in basis points, because
//! a float in a money path is a rounding bug waiting for a merchant to find it.

use crate::constants::{BPS, VALUATION_UNIT};

/// Integer square root — floor(√n).
///
/// Newton's method, entered from above so it descends monotonically and cannot
/// oscillate. The starting point is `2^ceil(bits/2)`, which is just above √n,
/// so this converges in a handful of iterations instead of the ~128 a naive
/// `x = n` start would cost. Compute budget is not free on chain.
pub fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    let bits = 128 - n.leading_zeros();
    // Never zero, so the division below is always safe.
    let mut x = 1u128 << bits.div_ceil(2);
    loop {
        let next = (x + n / x) / 2;
        if next >= x {
            return x;
        }
        x = next;
    }
}

/// The inputs to the curve, already resolved from accounts.
///
/// Kept as a plain struct with no Anchor types so the arithmetic can be tested
/// on the host without a validator — which is the only reason any of this is
/// provable without hardware.
#[derive(Clone, Copy, Debug)]
pub struct CurveParams {
    /// The vault's base offline limit, in settlement-mint base units.
    pub base: u64,
    /// Growth coefficient, in bps. `k_bps = 10_000` means a merchant holding
    /// exactly `stake_reference` of value doubles their base limit.
    pub k_bps: u32,
    /// The stake value at which `k_bps` applies in full, in settlement-mint
    /// base units. Normalising by this is what makes `k` a dimensionless
    /// number somebody can reason about rather than a magic constant.
    pub stake_reference: u64,
    /// Reputation multiplier in bps. 10_000 is neutral.
    pub reputation_bps: u16,
    /// The ceiling. Nothing below returns more than this.
    pub hard_cap: u64,
}

/// Value a stake holding conservatively, in settlement-mint base units.
///
/// `stake_price` is quoted per [`VALUATION_UNIT`] of stake base units and is
/// expected to be a TWAP rather than a spot print. The haircut is applied here,
/// visibly, rather than being folded into the published price — a collateral
/// model that hides its own discount is not auditable.
///
/// This is called at redemption, not at staking, so a stake is revalued when
/// the claim is made. SKR moves; collateral posted at a high price is not worth
/// what it was posted at.
pub fn stake_value(stake: u64, stake_price: u64, haircut_bps: u16) -> u128 {
    let haircut_bps = haircut_bps.min(BPS as u16) as u128;
    let gross = (stake as u128).saturating_mul(stake_price as u128) / VALUATION_UNIT;
    gross.saturating_mul(BPS - haircut_bps) / BPS
}

/// The curve itself.
///
/// Saturating throughout rather than checked: every path ends in `min(..,
/// hard_cap)`, so an overflow can only ever clamp to the cap, and a merchant
/// being held at their ceiling is the correct answer to absurd inputs. A
/// `checked_*` here would instead fail the redemption of a legitimate voucher.
pub fn offline_limit(params: CurveParams, stake_value: u128) -> u64 {
    let base = params.base as u128;
    let hard_cap = params.hard_cap as u128;

    // A zero reference would be a division by zero. The config validator
    // refuses one, so this is belt-and-braces: fall back to the uncurved base
    // rather than panicking inside a redemption.
    if params.stake_reference == 0 {
        return base.min(hard_cap) as u64;
    }

    // ratio, in bps: how much of a reference unit this merchant holds.
    let ratio_bps = stake_value
        .saturating_mul(BPS)
        .saturating_div(params.stake_reference as u128);

    // √ratio, in bps. √(ratio_bps × BPS) = √(ratio × BPS²) = √ratio × BPS.
    let sqrt_bps = isqrt(ratio_bps.saturating_mul(BPS));

    // multiplier = 1 + k·√ratio, in bps.
    let multiplier_bps = BPS.saturating_add((params.k_bps as u128).saturating_mul(sqrt_bps) / BPS);

    // limit = base × multiplier × reputation, unwinding both bps scales.
    let limit = base
        .saturating_mul(multiplier_bps)
        .saturating_mul(params.reputation_bps as u128)
        / (BPS * BPS);

    limit.min(hard_cap) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    /// $50 at six decimals — the base limit the tests reason in.
    const BASE: u64 = 50_000_000;
    /// $1,000 of stake value is the reference unit.
    const REFERENCE: u64 = 1_000_000_000;
    const HARD_CAP: u64 = 2_000_000_000;

    fn params() -> CurveParams {
        CurveParams {
            base: BASE,
            k_bps: 10_000, // one reference unit of stake doubles the base
            stake_reference: REFERENCE,
            reputation_bps: 10_000,
            hard_cap: HARD_CAP,
        }
    }

    // ------------------------------------------------------------ isqrt ---

    #[test]
    fn isqrt_matches_brute_force_on_small_values() {
        for n in 0u128..1000 {
            let root = isqrt(n);
            assert!(root * root <= n, "isqrt({n}) = {root} is too large");
            assert!(
                (root + 1) * (root + 1) > n,
                "isqrt({n}) = {root} is too small"
            );
        }
    }

    #[test]
    fn isqrt_is_exact_on_perfect_squares() {
        for r in [1u128, 2, 3, 7, 10, 99, 1000, 65_535, 1 << 32, 1 << 48] {
            assert_eq!(isqrt(r * r), r, "isqrt({}²)", r);
        }
    }

    /// The boundary a naive implementation overflows or loops forever on.
    #[test]
    fn isqrt_handles_the_top_of_the_range() {
        let root = isqrt(u128::MAX);
        assert_eq!(root, (1u128 << 64) - 1);
        // The floor property, stated where it can actually fail: the root
        // squared still fits, and one more does not.
        assert!(root.checked_mul(root).is_some(), "root² must not overflow");
        assert!(
            (root + 1).checked_mul(root + 1).is_none(),
            "root is not the floor if (root+1)² still fits"
        );
    }

    #[test]
    fn isqrt_never_overshoots_just_below_a_square() {
        for r in [2u128, 3, 10, 1000, 1 << 20, 1 << 40] {
            assert_eq!(isqrt(r * r - 1), r - 1, "just below {}²", r);
        }
    }

    // ------------------------------------------------- the curve proper ---

    /// The property the whole mechanism rests on. If this fails, trust is for
    /// sale by the yard and the collateral model means nothing.
    #[test]
    fn staking_raises_the_limit_sublinearly() {
        let p = params();
        let one = offline_limit(p, REFERENCE as u128);
        let four = offline_limit(p, 4 * REFERENCE as u128);

        let base_gain = one - BASE;
        let quad_gain = four - BASE;

        // Four times the stake buys exactly twice the uplift — √4 = 2 — which
        // is strictly less than four times, and that is the point.
        assert_eq!(quad_gain, 2 * base_gain, "√ growth: 4× stake, 2× uplift");
        assert!(quad_gain < 4 * base_gain, "uplift must not scale linearly");
    }

    /// Doubling never doubles, at any point on the curve.
    #[test]
    fn every_doubling_of_stake_yields_less_than_double_the_uplift() {
        let p = params();
        let mut stake = REFERENCE as u128 / 16;
        while stake < 64 * REFERENCE as u128 {
            let single = offline_limit(p, stake) - BASE;
            let double = offline_limit(p, stake * 2) - BASE;
            assert!(
                double < 2 * single,
                "stake {stake}: uplift {single} → {double} is not sublinear"
            );
            stake *= 2;
        }
    }

    #[test]
    fn zero_stake_leaves_the_base_limit_untouched() {
        // The migration property: a vault that has never staked behaves today
        // exactly as it did before the curve existed.
        assert_eq!(offline_limit(params(), 0), BASE);
    }

    #[test]
    fn the_hard_cap_holds_against_an_absurd_stake() {
        let p = params();
        assert_eq!(offline_limit(p, u128::MAX), HARD_CAP);
        assert_eq!(offline_limit(p, (u64::MAX as u128) * 1_000), HARD_CAP);
    }

    /// A compromised or simply wrong risk authority must not be able to lift a
    /// merchant past the ceiling, whatever it publishes.
    /// A cap the tests can actually reach, so the ceiling is demonstrated
    /// rather than asserted. With k = 1.0 and base $50 it bites at mult 3 —
    /// that is `1 + √r = 3`, so at four reference units of stake.
    const TIGHT_CAP: u64 = 150_000_000;

    fn capped() -> CurveParams {
        CurveParams {
            hard_cap: TIGHT_CAP,
            ..params()
        }
    }

    #[test]
    fn the_hard_cap_holds_against_an_absurd_reputation() {
        let p = CurveParams {
            reputation_bps: u16::MAX,
            ..capped()
        };
        assert_eq!(offline_limit(p, REFERENCE as u128), TIGHT_CAP);
    }

    #[test]
    fn the_hard_cap_holds_against_an_absurd_coefficient() {
        let p = CurveParams {
            k_bps: u32::MAX,
            ..params()
        };
        assert_eq!(offline_limit(p, REFERENCE as u128), HARD_CAP);
    }

    /// Saturation is the designed behaviour, not a bug: past the cap, more
    /// collateral is dead capital. This is the test that documents it.
    #[test]
    fn the_limit_saturates_and_stops_rewarding_more_collateral() {
        let p = capped();

        // Below the cap the curve is still doing its job...
        let under = offline_limit(p, REFERENCE as u128);
        assert_eq!(under, 100_000_000, "1 + √1 = 2, so $50 → $100");
        assert!(under < TIGHT_CAP, "the cap must not be a constant return");

        // ...it reaches the ceiling exactly where the arithmetic says it does...
        assert_eq!(
            offline_limit(p, 4 * REFERENCE as u128),
            TIGHT_CAP,
            "1 + √4 = 3"
        );

        // ...and past it, more collateral is dead capital. That is the designed
        // behaviour, and the reason earning has to be a separate mechanism.
        assert_eq!(offline_limit(p, 9 * REFERENCE as u128), TIGHT_CAP);
        assert_eq!(offline_limit(p, 10_000 * REFERENCE as u128), TIGHT_CAP);
    }

    #[test]
    fn reputation_scales_the_limit_and_can_penalise() {
        let p = params();
        let neutral = offline_limit(p, REFERENCE as u128);

        let halved = offline_limit(
            CurveParams {
                reputation_bps: 5_000,
                ..p
            },
            REFERENCE as u128,
        );
        assert_eq!(halved, neutral / 2, "a disputed merchant is trusted less");

        // Reputation decays to nothing with inactivity; the floor is zero, and
        // a zero-reputation merchant simply cannot emit an offline voucher.
        let dormant = offline_limit(
            CurveParams {
                reputation_bps: 0,
                ..p
            },
            REFERENCE as u128,
        );
        assert_eq!(dormant, 0);
    }

    #[test]
    fn a_zero_reference_falls_back_to_the_base_rather_than_dividing_by_zero() {
        let p = CurveParams {
            stake_reference: 0,
            ..params()
        };
        assert_eq!(offline_limit(p, REFERENCE as u128), BASE);
    }

    #[test]
    fn k_of_zero_disables_the_curve_entirely() {
        let p = CurveParams {
            k_bps: 0,
            ..params()
        };
        assert_eq!(offline_limit(p, 1_000 * REFERENCE as u128), BASE);
    }

    // ---------------------------------------------------- the valuation ---

    #[test]
    fn the_haircut_discounts_the_stake() {
        // 1_000 stake units at 1.0 settlement units each, VALUATION_UNIT scaled.
        let price = VALUATION_UNIT as u64; // 1 settlement unit per stake unit
        assert_eq!(stake_value(1_000, price, 0), 1_000);
        assert_eq!(stake_value(1_000, price, 5_000), 500, "50% haircut");
        assert_eq!(stake_value(1_000, price, 10_000), 0, "100% haircut");
    }

    /// The collateral model is not allowed to pretend its collateral is stable.
    /// A halved price halves the limit uplift, at redemption time.
    #[test]
    fn a_falling_price_shrinks_the_limit_at_redemption() {
        let p = params();
        let stake = 4_000_000_000u64;
        let high = stake_value(stake, VALUATION_UNIT as u64, 5_000);
        let low = stake_value(stake, VALUATION_UNIT as u64 / 2, 5_000);

        assert_eq!(low, high / 2);
        assert!(
            offline_limit(p, low) < offline_limit(p, high),
            "a stake worth less must not hold the same limit"
        );
    }

    #[test]
    fn valuation_saturates_rather_than_overflowing() {
        assert_eq!(stake_value(0, u64::MAX, 0), 0);
        // Absurd but must not panic; the cap catches it downstream.
        let v = stake_value(u64::MAX, u64::MAX, 0);
        assert_eq!(offline_limit(params(), v), HARD_CAP);
    }
}
