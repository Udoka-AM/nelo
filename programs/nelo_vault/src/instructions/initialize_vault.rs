use anchor_lang::prelude::*;

use crate::{constants::*, state::Vault};

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_vault(
    ctx: Context<InitializeVault>,
    device_pubkey: [u8; 33],
    attestation_id: [u8; 32],
    mint: Pubkey,
    floor_limit: u64,
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    vault.owner = ctx.accounts.owner.key();
    vault.mint = mint;
    vault.device_pubkey = device_pubkey;
    vault.attestation_id = attestation_id;
    vault.balance = 0;
    vault.seq_base = 0;
    vault.seq_bitmap = 0;
    vault.floor_limit = floor_limit;
    vault.unlock_at = 0;
    vault.status = VAULT_STATUS_ACTIVE;
    vault.bump = ctx.bumps.vault;
    Ok(())
}
