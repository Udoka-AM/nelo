use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{constants::*, error::NeloError, state::Vault};

#[derive(Accounts)]
pub struct RequestWithdraw<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, Vault>,
}

/// Open the timelock. Without this the attack is trivial: go offline, sign
/// vouchers at every stall on the street, get home, withdraw the collateral
/// before any merchant reconnects. Vouchers still redeem normally during the
/// delay — the timelock blocks the exit, not the payees.
pub fn handle_request_withdraw(ctx: Context<RequestWithdraw>) -> Result<()> {
    require!(ctx.accounts.vault.is_active(), NeloError::VaultFrozen);
    let now = Clock::get()?.unix_timestamp;
    ctx.accounts.vault.unlock_at = now
        .checked_add(WITHDRAW_TIMELOCK_SECONDS)
        .ok_or(NeloError::Overflow)?;
    Ok(())
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
        has_one = mint @ NeloError::MintMismatch,
    )]
    pub vault: Account<'info, Vault>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        token::mint = mint,
        token::authority = owner,
        token::token_program = token_program,
    )]
    pub owner_token: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_token: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    require!(ctx.accounts.vault.is_active(), NeloError::VaultFrozen);

    let unlock_at = ctx.accounts.vault.unlock_at;
    require!(unlock_at != 0, NeloError::WithdrawNotRequested);
    let now = Clock::get()?.unix_timestamp;
    require!(now >= unlock_at, NeloError::WithdrawTimelockActive);

    let vault = &mut ctx.accounts.vault;
    vault.balance = vault
        .balance
        .checked_sub(amount)
        .ok_or(NeloError::InsufficientCollateral)?;
    // Consume the request, so each withdrawal needs its own timelock.
    vault.unlock_at = 0;

    let owner = vault.owner;
    let bump = vault.bump;
    let seeds: &[&[u8]] = &[VAULT_SEED, owner.as_ref(), &[bump]];
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.vault_token.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.owner_token.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    Ok(())
}
