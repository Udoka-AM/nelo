//! Staking, and the exit.
//!
//! The exit is not an afterthought. A balance that is never spendable is not
//! earnings, and a merchant will correctly refuse to treat it as such — so the
//! way out is built at the same time as the way in, and the only thing standing
//! in it is a cooldown long enough to cover the settlement horizon.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

use crate::{
    constants::*,
    error::NeloError,
    state::{RiskConfig, Vault},
};

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        seeds = [RISK_CONFIG_SEED],
        bump = config.bump,
        has_one = stake_mint @ NeloError::StakeMintMismatch,
    )]
    pub config: Account<'info, RiskConfig>,

    pub stake_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        token::mint = stake_mint,
        token::authority = owner,
        token::token_program = token_program,
    )]
    pub owner_stake_token: InterfaceAccount<'info, TokenAccount>,

    /// Staked tokens sit under the vault PDA, not the owner's wallet. Created
    /// on demand: a merchant staking for the first time has never held SKR.
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = stake_mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_stake_token: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Post first-loss capital, and buy a higher offline ceiling with it.
///
/// The uplift is sublinear and capped — see [`crate::curve`]. Past the point
/// where the limit covers the merchant's largest realistic basket this buys
/// nothing at all, which is correct behaviour for collateral and precisely why
/// the earning side of the Trust Stake is a separate mechanism.
pub fn handle_stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
    require!(ctx.accounts.vault.is_active(), NeloError::VaultFrozen);
    require!(amount > 0, NeloError::ZeroAmount);

    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.owner_stake_token.to_account_info(),
                mint: ctx.accounts.stake_mint.to_account_info(),
                to: ctx.accounts.vault_stake_token.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.stake_mint.decimals,
    )?;

    let vault = &mut ctx.accounts.vault;
    vault.stake = vault.stake.checked_add(amount).ok_or(NeloError::Overflow)?;
    Ok(())
}

#[derive(Accounts)]
pub struct RequestUnstake<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, Vault>,

    #[account(seeds = [RISK_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, RiskConfig>,
}

/// Open the unstake cooldown.
///
/// The requested amount stops backing the offline limit immediately, not when
/// it is collected — otherwise a payer requests the whole stake, keeps trading
/// at the ceiling it was buying, and walks off with it at the end of the
/// cooldown.
///
/// A frozen vault cannot request. Stake is first-loss capital against exactly
/// the event that froze it, and capital that can leave after the loss is not
/// collateral.
pub fn handle_request_unstake(ctx: Context<RequestUnstake>, amount: u64) -> Result<()> {
    require!(ctx.accounts.vault.is_active(), NeloError::VaultFrozen);
    require!(amount > 0, NeloError::ZeroAmount);

    let cooldown = ctx.accounts.config.unstake_cooldown;
    let vault = &mut ctx.accounts.vault;
    require!(amount <= vault.stake, NeloError::InsufficientStake);

    let now = Clock::get()?.unix_timestamp;
    vault.pending_unstake = amount;
    vault.unstake_unlock_at = now.checked_add(cooldown).ok_or(NeloError::Overflow)?;
    Ok(())
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        seeds = [RISK_CONFIG_SEED],
        bump = config.bump,
        has_one = stake_mint @ NeloError::StakeMintMismatch,
    )]
    pub config: Account<'info, RiskConfig>,

    pub stake_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        token::mint = stake_mint,
        token::authority = owner,
        token::token_program = token_program,
    )]
    pub owner_stake_token: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = stake_mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_stake_token: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Collect, once the cooldown has elapsed.
pub fn handle_unstake(ctx: Context<Unstake>) -> Result<()> {
    require!(ctx.accounts.vault.is_active(), NeloError::VaultFrozen);

    let pending = ctx.accounts.vault.pending_unstake;
    require!(pending > 0, NeloError::UnstakeNotRequested);

    let unlock_at = ctx.accounts.vault.unstake_unlock_at;
    let now = Clock::get()?.unix_timestamp;
    require!(now >= unlock_at, NeloError::UnstakeCooldownActive);

    let vault = &mut ctx.accounts.vault;
    let amount = pending.min(vault.stake);
    vault.stake = vault.stake.saturating_sub(amount);
    // Consume the request, so each collection needs its own cooldown.
    vault.pending_unstake = 0;
    vault.unstake_unlock_at = 0;

    let owner = vault.owner;
    let bump = vault.bump;
    let seeds: &[&[u8]] = &[VAULT_SEED, owner.as_ref(), &[bump]];
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.vault_stake_token.to_account_info(),
                mint: ctx.accounts.stake_mint.to_account_info(),
                to: ctx.accounts.owner_stake_token.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        ctx.accounts.stake_mint.decimals,
    )?;

    Ok(())
}
