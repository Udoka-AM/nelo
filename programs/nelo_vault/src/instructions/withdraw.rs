use anchor_lang::prelude::*;

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
    )]
    pub vault: Account<'info, Vault>,
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

    let vault_ai = vault.to_account_info();
    let owner_ai = ctx.accounts.owner.to_account_info();
    **vault_ai.try_borrow_mut_lamports()? = vault_ai
        .lamports()
        .checked_sub(amount)
        .ok_or(NeloError::InsufficientCollateral)?;
    **owner_ai.try_borrow_mut_lamports()? = owner_ai
        .lamports()
        .checked_add(amount)
        .ok_or(NeloError::Overflow)?;

    Ok(())
}
