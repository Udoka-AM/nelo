//! Nelo vault — locked collateral, a 128-slot replay window, a timelocked
//! withdrawal, and offline vouchers signed by an Android StrongBox P-256 key
//! and verified on chain by the secp256r1 precompile.
//!
//! Week-1 scope, per docs/DELIVERABLES.md. Collateral is native lamports; the
//! USDC/SPL leg is week 2. A proven double-spend freezes the vault via
//! `report_conflict`; the freeze blocks the payer's exit but deliberately
//! leaves redemption open, so honest merchants can still claim collateral.

pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;
pub mod voucher;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;
pub use voucher::VoucherArgs;

declare_id!("yzDTDHq5cjLW1QZkfH1UEggMtLe8SaNr3MXQgRwpzhu");

#[program]
pub mod nelo_vault {
    use super::*;

    /// Enrol a device key and open a vault.
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        device_pubkey: [u8; 33],
        attestation_id: [u8; 32],
        mint: Pubkey,
        floor_limit: u64,
    ) -> Result<()> {
        instructions::initialize_vault::handle_initialize_vault(
            ctx,
            device_pubkey,
            attestation_id,
            mint,
            floor_limit,
        )
    }

    /// Lock collateral before going offline.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::deposit::handle_deposit(ctx, amount)
    }

    /// Redeem an offline voucher. Instruction 0 of the transaction must be the
    /// secp256r1 precompile verifying this voucher's 105 signed bytes.
    pub fn redeem_voucher(ctx: Context<RedeemVoucher>, voucher: VoucherArgs) -> Result<()> {
        instructions::redeem_voucher::handle_redeem_voucher(ctx, voucher)
    }

    /// Freeze a vault on proof of a double-spend. Permissionless: instructions
    /// 0 and 1 must be the secp256r1 precompile verifying each voucher.
    pub fn report_conflict(
        ctx: Context<ReportConflict>,
        voucher_a: VoucherArgs,
        voucher_b: VoucherArgs,
    ) -> Result<()> {
        instructions::report_conflict::handle_report_conflict(ctx, voucher_a, voucher_b)
    }

    /// Start the withdrawal timelock.
    pub fn request_withdraw(ctx: Context<RequestWithdraw>) -> Result<()> {
        instructions::withdraw::handle_request_withdraw(ctx)
    }

    /// Withdraw, once the timelock has elapsed.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        instructions::withdraw::handle_withdraw(ctx, amount)
    }
}
