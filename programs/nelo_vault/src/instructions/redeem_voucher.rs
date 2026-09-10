use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};
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
        has_one = mint @ NeloError::MintMismatch,
    )]
    pub vault: Account<'info, Vault>,

    pub mint: InterfaceAccount<'info, Mint>,

    /// The payee named in the voucher. A voucher is not bearer.
    /// CHECK: identity only — it is the ATA authority, checked by address below.
    #[account(address = voucher.merchant @ NeloError::MerchantMismatch)]
    pub merchant: UncheckedAccount<'info>,

    /// Created on demand: a merchant taking their first Nelo payment has never
    /// held USDC, and that must not be the thing that fails a sale.
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = merchant,
        associated_token::token_program = token_program,
    )]
    pub merchant_token: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_token: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: address-checked against the instructions sysvar; read only.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
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
    vault.balance = vault
        .balance
        .checked_sub(voucher.amount)
        .ok_or(NeloError::InsufficientCollateral)?;

    // --- move the collateral ---
    let owner = vault.owner;
    let bump = vault.bump;
    let seeds: &[&[u8]] = &[VAULT_SEED, owner.as_ref(), &[bump]];
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.vault_token.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.merchant_token.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[seeds],
        ),
        voucher.amount,
        ctx.accounts.mint.decimals,
    )?;

    Ok(())
}
