use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Vault {
    /// The payer who funded this vault.
    pub owner: Pubkey,
    /// Settlement mint. USDC in production; collateral is SPL throughout.
    pub mint: Pubkey,
    /// P-256 public key of the device secure element, SEC1 compressed.
    pub device_pubkey: [u8; 33],
    /// Hash of the verified StrongBox attestation chain.
    pub attestation_id: [u8; 32],
    /// Locked collateral, in settlement-mint base units.
    pub balance: u64,
    /// Lowest sequence still tracked by the replay window.
    pub seq_base: u64,
    /// 128-slot sliding replay window, one bit per sequence from `seq_base`.
    pub seq_bitmap: u128,
    /// Base offline limit for this vault, before the Trust Stake curve.
    ///
    /// This is the floor, not the ceiling: the effective limit is
    /// [`crate::curve::offline_limit`] applied to this, the staked value and
    /// the reputation below. With no stake and neutral reputation the two are
    /// the same number, which is what makes the curve safe to add to a vault
    /// that already exists.
    pub floor_limit: u64,
    /// Unix seconds after which `withdraw` is permitted. 0 = no request open.
    pub unlock_at: i64,

    // ---- Trust Stake ----
    /// SKR staked against this vault, in stake-mint base units. First-loss
    /// capital: it is what the higher offline limit is bought with.
    ///
    /// On a frozen vault this is the stake that set the limit merchants were
    /// given, and `slash` leaves it in place after moving the tokens to the
    /// reserve. The vault's stake token account is what records the tokens
    /// actually held. See `instructions::slash`.
    pub stake: u64,
    /// Reputation multiplier in bps, published by the risk authority from
    /// settled volume, dispute rate and tenure. Decays with inactivity.
    pub reputation_bps: u16,
    /// Stake requested for withdrawal, held out of the curve from the moment
    /// it is requested rather than when it is collected.
    pub pending_unstake: u64,
    /// Unix seconds after which `unstake` is permitted. 0 = no request open.
    pub unstake_unlock_at: i64,

    pub status: u8,
    pub bump: u8,
}

impl Vault {
    pub fn is_active(&self) -> bool {
        self.status == crate::constants::VAULT_STATUS_ACTIVE
    }

    /// Stake still backing the offline limit.
    ///
    /// Requested-but-uncollected stake stops counting the moment the request
    /// is made. Otherwise a payer opens an unstake request, keeps trading at
    /// the limit that stake was buying, and collects it at the end of the
    /// cooldown — which is the whole attack the cooldown exists to prevent.
    pub fn effective_stake(&self) -> u64 {
        self.stake.saturating_sub(self.pending_unstake)
    }
}

/// Platform-wide risk parameters.
///
/// These are deliberately **not** compile-time constants. `base`, `k` and the
/// hard cap fall out of the reserve model — every unit of merchant collateral
/// is a unit the platform reserve does not have to hold, and the SKR premium is
/// priced off exactly that. That model is a commercial artefact, not a code
/// one, so it lands here as configuration and can be revised without a
/// redeploy. Baking in three plausible-looking numbers would be inventing the
/// answer to the question the model is supposed to settle.
#[account]
#[derive(InitSpace)]
pub struct RiskConfig {
    /// May update these parameters and publish reputation. Held separately
    /// from the program upgrade authority from the start.
    pub authority: Pubkey,
    /// The stake mint. SKR in production.
    pub stake_mint: Pubkey,
    /// Growth coefficient in bps: the uplift at one reference unit of stake.
    pub k_bps: u32,
    /// The stake value at which `k_bps` applies in full, in settlement-mint
    /// base units.
    pub stake_reference: u64,
    /// The ceiling on any single vault's offline limit.
    pub hard_cap: u64,
    /// Settlement-mint base units per [`crate::constants::VALUATION_UNIT`] of
    /// stake, before the haircut. Expected to be a TWAP.
    pub stake_price: u64,
    /// Conservative discount applied to `stake_price`, in bps. Held visibly
    /// rather than folded into the price, so the discount is auditable.
    pub haircut_bps: u16,
    /// Delay between `request_unstake` and `unstake`.
    pub unstake_cooldown: i64,
    pub bump: u8,
}
