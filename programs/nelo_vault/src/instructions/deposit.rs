use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

use crate::{constants::*, error::NeloError, state::Vault};

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, Vault>,
    pub system_program: Program<'info, System>,
}

/// Lock collateral. Offline mode is a prepaid balance, not a promise to pay —
/// you cannot spend offline what you have not already locked here.
pub fn handle_deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(ctx.accounts.vault.is_active(), NeloError::VaultFrozen);

    transfer(
        CpiContext::new(
            anchor_lang::system_program::ID,
            Transfer {
                from: ctx.accounts.owner.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        ),
        amount,
    )?;

    let vault = &mut ctx.accounts.vault;
    vault.balance = vault.balance.checked_add(amount).ok_or(NeloError::Overflow)?;
    Ok(())
}
