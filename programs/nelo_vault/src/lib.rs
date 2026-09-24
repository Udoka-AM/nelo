//! Nelo vault — locked collateral, a 128-slot replay window, a timelocked
//! withdrawal, and offline vouchers signed by an Android StrongBox P-256 key
//! and verified on chain by the secp256r1 precompile.
//!
//! The offline limit is not a fixed number: it is bought with staked SKR
//! through a sublinear, hard-capped curve (see `curve`), so trust cannot
//! simply be purchased and no merchant creates unbounded exposure.
//!
//! Per docs/DELIVERABLES.md.
//! Collateral is SPL — USDC in production. A proven double-spend freezes the vault via
//! `report_conflict`; the freeze blocks the payer's exit but deliberately
//! leaves redemption open, so honest merchants can still claim collateral.
//! `slash` then moves the frozen vault's stake into the platform reserve.

pub mod constants;
pub mod curve;
pub mod error;
pub mod instructions;
pub mod state;
pub mod voucher;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;
pub use voucher::VoucherArgs;

declare_id!("29QdPRQC8C5v6C8gMcBqtw9T4RxYyZ1wqThkEj3XJeQx");

#[program]
pub mod nelo_vault {
    use super::*;

    /// Enrol a device key and open a vault.
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        device_pubkey: [u8; 33],
        attestation_id: [u8; 32],
        floor_limit: u64,
    ) -> Result<()> {
        instructions::initialize_vault::handle_initialize_vault(
            ctx,
            device_pubkey,
            attestation_id,
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

    // ---- Trust Stake ----

    /// Open the platform-wide risk configuration.
    pub fn initialize_risk_config(
        ctx: Context<InitializeRiskConfig>,
        params: RiskParams,
    ) -> Result<()> {
        instructions::risk_config::handle_initialize_risk_config(ctx, params)
    }

    /// Revise the risk parameters. This is where the reserve model lands.
    pub fn update_risk_config(ctx: Context<UpdateRiskConfig>, params: RiskParams) -> Result<()> {
        instructions::risk_config::handle_update_risk_config(ctx, params)
    }

    /// Publish a fresh stake valuation and haircut.
    pub fn publish_stake_price(
        ctx: Context<UpdateRiskConfig>,
        stake_price: u64,
        haircut_bps: u16,
    ) -> Result<()> {
        instructions::risk_config::handle_publish_stake_price(ctx, stake_price, haircut_bps)
    }

    /// Publish a merchant's reputation multiplier.
    pub fn set_reputation(ctx: Context<SetReputation>, reputation_bps: u16) -> Result<()> {
        instructions::risk_config::handle_set_reputation(ctx, reputation_bps)
    }

    /// Stake SKR as first-loss capital, raising the offline limit sublinearly.
    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        instructions::stake::handle_stake(ctx, amount)
    }

    /// Start the unstake cooldown. The amount stops backing the limit at once.
    pub fn request_unstake(ctx: Context<RequestUnstake>, amount: u64) -> Result<()> {
        instructions::stake::handle_request_unstake(ctx, amount)
    }

    /// Collect the requested stake, once the cooldown has elapsed.
    pub fn unstake(ctx: Context<Unstake>) -> Result<()> {
        instructions::stake::handle_unstake(ctx)
    }

    /// Move a frozen vault's stake into the platform reserve. Permissionless.
    pub fn slash(ctx: Context<Slash>) -> Result<()> {
        instructions::slash::handle_slash(ctx)
    }
}
