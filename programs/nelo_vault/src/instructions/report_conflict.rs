use anchor_lang::prelude::*;
use solana_sdk_ids::sysvar::instructions::ID as INSTRUCTIONS_SYSVAR_ID;

use crate::{
    constants::*,
    error::NeloError,
    state::Vault,
    voucher::{assert_precompile_verified, VoucherArgs},
};

/// Emitted so a risk service can index conflicts without replaying history.
#[event]
pub struct ConflictReported {
    pub vault: Pubkey,
    pub seq: u64,
    pub reporter: Pubkey,
}

#[derive(Accounts)]
pub struct ReportConflict<'info> {
    /// Permissionless. Anyone holding the proof can freeze the vault — a
    /// merchant who was defrauded should not have to wait for an authority.
    #[account(mut)]
    pub reporter: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.owner.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    /// CHECK: address-checked against the instructions sysvar; read only.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
}

/// Freeze a vault on proof of a double-spend.
///
/// The replay window refuses the *second* redemption at a sequence, but that
/// refusal cannot itself freeze anything: returning an error rolls back every
/// account write in the transaction, the freeze included. So the freeze has to
/// be its own instruction, carrying its own proof.
///
/// The proof is two different vouchers at the same sequence, both signed by the
/// key enrolled on this vault. That is not something an honest payer's secure
/// element ever produces, and it holds whether or not either voucher has been
/// redeemed — which matters, because the fraud is provable before the second
/// merchant ever reconnects.
///
/// Instructions 0 and 1 of the transaction must be the secp256r1 precompile
/// verifying voucher A and voucher B respectively.
pub fn handle_report_conflict(
    ctx: Context<ReportConflict>,
    voucher_a: VoucherArgs,
    voucher_b: VoucherArgs,
) -> Result<()> {
    let vault_key = ctx.accounts.vault.key();

    require!(
        voucher_a.version == VOUCHER_VERSION && voucher_b.version == VOUCHER_VERSION,
        NeloError::BadVoucherVersion
    );
    require_keys_eq!(voucher_a.vault, vault_key, NeloError::VaultMismatch);
    require_keys_eq!(voucher_b.vault, vault_key, NeloError::VaultMismatch);

    // Same slot, different content. Identical bytes are a replay of one
    // voucher, which is not fraud by the payer and must not freeze anything.
    require!(voucher_a.seq == voucher_b.seq, NeloError::NotSameSequence);
    let msg_a = voucher_a.signed_message();
    let msg_b = voucher_b.signed_message();
    require!(msg_a != msg_b, NeloError::NotAConflict);

    // Both must carry this vault's enrolled device signature, or anyone could
    // freeze anyone by inventing two vouchers.
    let device_pubkey = ctx.accounts.vault.device_pubkey;
    let sysvar = ctx.accounts.instructions.to_account_info();
    assert_precompile_verified(&sysvar, CONFLICT_IX_INDEX_A, &device_pubkey, &msg_a)?;
    assert_precompile_verified(&sysvar, CONFLICT_IX_INDEX_B, &device_pubkey, &msg_b)?;

    let vault = &mut ctx.accounts.vault;
    vault.status = VAULT_STATUS_FROZEN;
    // Cancel any withdrawal already in flight, so the timelock cannot mature
    // into an exit after the fraud is proven.
    vault.unlock_at = 0;

    emit!(ConflictReported {
        vault: vault_key,
        seq: voucher_a.seq,
        reporter: ctx.accounts.reporter.key(),
    });

    Ok(())
}
