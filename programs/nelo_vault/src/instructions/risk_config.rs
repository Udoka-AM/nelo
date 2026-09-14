//! The risk parameters, and who is allowed to move them.
//!
//! Everything the floor-limit curve is shaped by lives in one account under one
//! authority, held separately from the program upgrade authority. That
//! separation is the point: publishing a price is a routine operation that
//! happens often, and it must not need the key that can replace the program.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::{
    constants::*,
    error::NeloError,
    state::{RiskConfig, Vault},
};

/// The tunables. `stake_mint` is not here — changing it would orphan every
/// token already staked, so it is set once at initialisation and never moved.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct RiskParams {
    /// Also the rotation path: publishing a price is frequent, so the key that
    /// does it has to be replaceable without a redeploy.
    pub authority: Pubkey,
    pub k_bps: u32,
    pub stake_reference: u64,
    pub hard_cap: u64,
    pub stake_price: u64,
    pub haircut_bps: u16,
    pub unstake_cooldown: i64,
}

impl RiskParams {
    fn validate(&self) -> Result<()> {
        require!(self.authority != Pubkey::default(), NeloError::BadRiskParams);
        // Divides the stake value; zero would be a division by zero inside a
        // redemption, which is the worst possible place to discover it.
        require!(self.stake_reference != 0, NeloError::BadRiskParams);
        // A zero cap would silently refuse every voucher on the platform.
        require!(self.hard_cap != 0, NeloError::BadRiskParams);
        require!(self.haircut_bps <= BPS as u16, NeloError::BadRiskParams);
        // Shorter than the settlement horizon and a payer can unstake to
        // escape a loss still in flight. See MIN_UNSTAKE_COOLDOWN_SECONDS.
        require!(
            self.unstake_cooldown >= MIN_UNSTAKE_COOLDOWN_SECONDS,
            NeloError::CooldownTooShort
        );
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeRiskConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + RiskConfig::INIT_SPACE,
        seeds = [RISK_CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, RiskConfig>,

    /// The stake mint. SKR in production.
    pub stake_mint: InterfaceAccount<'info, Mint>,

    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_risk_config(
    ctx: Context<InitializeRiskConfig>,
    params: RiskParams,
) -> Result<()> {
    params.validate()?;
    let config = &mut ctx.accounts.config;
    config.authority = params.authority;
    config.stake_mint = ctx.accounts.stake_mint.key();
    config.k_bps = params.k_bps;
    config.stake_reference = params.stake_reference;
    config.hard_cap = params.hard_cap;
    config.stake_price = params.stake_price;
    config.haircut_bps = params.haircut_bps;
    config.unstake_cooldown = params.unstake_cooldown;
    config.bump = ctx.bumps.config;
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateRiskConfig<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [RISK_CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ NeloError::NotRiskAuthority,
    )]
    pub config: Account<'info, RiskConfig>,
}

/// Replace the tunables wholesale.
///
/// This is where the reserve model lands once it exists — as configuration,
/// not as a redeploy.
pub fn handle_update_risk_config(ctx: Context<UpdateRiskConfig>, params: RiskParams) -> Result<()> {
    params.validate()?;
    let config = &mut ctx.accounts.config;
    config.authority = params.authority;
    config.k_bps = params.k_bps;
    config.stake_reference = params.stake_reference;
    config.hard_cap = params.hard_cap;
    config.stake_price = params.stake_price;
    config.haircut_bps = params.haircut_bps;
    config.unstake_cooldown = params.unstake_cooldown;
    Ok(())
}

/// Publish a fresh valuation. The frequent operation, kept separate from the
/// structural parameters so a routine price update cannot accidentally rewrite
/// the hard cap.
pub fn handle_publish_stake_price(
    ctx: Context<UpdateRiskConfig>,
    stake_price: u64,
    haircut_bps: u16,
) -> Result<()> {
    require!(haircut_bps <= BPS as u16, NeloError::BadRiskParams);
    let config = &mut ctx.accounts.config;
    config.stake_price = stake_price;
    config.haircut_bps = haircut_bps;
    Ok(())
}

#[derive(Accounts)]
pub struct SetReputation<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [RISK_CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ NeloError::NotRiskAuthority,
    )]
    pub config: Account<'info, RiskConfig>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.owner.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,
}

/// Publish a merchant's reputation.
///
/// Computed off chain from settled volume, dispute rate and tenure — none of
/// which the program can see — and bounded here so that a wrong or compromised
/// risk authority cannot lift every merchant at once. Reputation decays with
/// inactivity, so a dormant stake does not hold a high limit indefinitely; the
/// decay is applied by republishing, which is why this instruction exists at
/// all rather than the value being set once at enrolment.
pub fn handle_set_reputation(ctx: Context<SetReputation>, reputation_bps: u16) -> Result<()> {
    require!(
        reputation_bps <= REPUTATION_MAX_BPS,
        NeloError::ReputationOutOfRange
    );
    ctx.accounts.vault.reputation_bps = reputation_bps;
    Ok(())
}
