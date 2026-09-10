use anchor_lang::prelude::*;
use solana_sdk_ids::sysvar::instructions::ID as INSTRUCTIONS_SYSVAR_ID;

use crate::{
    constants::*,
    error::NeloError,
    state::Vault,
    voucher::{assert_precompile_verified, consume_sequence, VoucherArgs},
};

#[derive(Accounts)]
#[instruction(voucher: VoucherArgs)]
pub struct RedeemVoucher<'info> {
    /// Whoever broadcasts. Usually the merchant on reconnect, or the relayer.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.owner.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    /// The payee named in the voucher. A voucher is not bearer.
    #[account(mut, address = voucher.merchant @ NeloError::MerchantMismatch)]
    pub merchant: SystemAccount<'info>,

    /// CHECK: address-checked against the instructions sysvar; read only.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
}

pub fn handle_redeem_voucher(ctx: Context<RedeemVoucher>, voucher: VoucherArgs) -> Result<()> {
    let vault_key = ctx.accounts.vault.key();

    // --- shape of the voucher itself ---
    require!(
        voucher.version == VOUCHER_VERSION,
        NeloError::BadVoucherVersion
    );
    require_keys_eq!(voucher.vault, vault_key, NeloError::VaultMismatch);
    // Deliberately no `is_active` check. A freeze blocks the payer's exit, not
    // the payees: merchants holding good vouchers must still be able to claim
    // against locked collateral. The replay window already caps the damage —
    // only one voucher per sequence can ever settle. See report_conflict.

    let now = Clock::get()?.unix_timestamp;
    require!(now <= voucher.expires_at, NeloError::VoucherExpired);

    require!(
        voucher.amount <= ctx.accounts.vault.floor_limit,
        NeloError::AboveFloorLimit
    );
    require!(
        voucher.amount <= ctx.accounts.vault.balance,
        NeloError::InsufficientCollateral
    );

    // --- the signature actually came from this vault's enrolled device ---
    let device_pubkey = ctx.accounts.vault.device_pubkey;
    assert_precompile_verified(
        &ctx.accounts.instructions.to_account_info(),
        PRECOMPILE_IX_INDEX,
        &device_pubkey,
        &voucher.signed_message(),
    )?;

    // --- replay window: this is where a double-spend dies ---
    let vault = &mut ctx.accounts.vault;
    consume_sequence(vault, voucher.seq)?;

    // --- move the collateral ---
    vault.balance = vault
        .balance
        .checked_sub(voucher.amount)
        .ok_or(NeloError::InsufficientCollateral)?;

    // The vault PDA is owned by this program, so lamports move by direct
    // mutation rather than a system CPI. `balance` is tracked separately from
    // lamports precisely so rent-exemption is never spent down.
    let vault_ai = vault.to_account_info();
    let merchant_ai = ctx.accounts.merchant.to_account_info();
    **vault_ai.try_borrow_mut_lamports()? = vault_ai
        .lamports()
        .checked_sub(voucher.amount)
        .ok_or(NeloError::InsufficientCollateral)?;
    **merchant_ai.try_borrow_mut_lamports()? = merchant_ai
        .lamports()
        .checked_add(voucher.amount)
        .ok_or(NeloError::Overflow)?;

    Ok(())
}
