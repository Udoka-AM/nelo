//! Slashing: moving a proven double-spender's stake into the platform reserve.
//!
//! A conflict proof freezes the vault, which stops the stake from leaving. That
//! is half of "first-loss capital". The other half is this: taking the stake
//! away from the payer, so that it can pay for the loss it was backing.

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

/// Emitted so the risk service can reconcile the reserve without replaying
/// history.
#[event]
pub struct StakeSlashed {
    pub vault: Pubkey,
    pub amount: u64,
    pub cranker: Pubkey,
}

#[derive(Accounts)]
pub struct Slash<'info> {
    /// Permissionless, like the conflict proof that makes it possible. The
    /// destination is fixed and the amount is everything, so the caller only
    /// decides *when*, and after a proven double-spend, sooner is better.
    /// Pays the reserve account's rent the first time anything is slashed.
    #[account(mut)]
    pub cranker: Signer<'info>,

    /// Checked frozen in the handler. Not `mut`: no field changes (see the
    /// handler for why).
    #[account(
        seeds = [VAULT_SEED, vault.owner.as_ref()],
        bump = vault.bump,
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
        associated_token::mint = stake_mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_stake_token: InterfaceAccount<'info, TokenAccount>,

    /// The platform reserve: the stake mint's associated account under the
    /// risk-config PDA. A PDA owns it, so no key does. Tokens leave only through
    /// an instruction this program adds. The address is derived, not passed in
    /// as a choice, so a caller cannot slash into an account of their own.
    #[account(
        init_if_needed,
        payer = cranker,
        associated_token::mint = stake_mint,
        associated_token::authority = config,
        associated_token::token_program = token_program,
    )]
    pub reserve_stake_token: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Move every staked token of a frozen vault into the reserve.
///
/// **All of it, at once.** A freeze is only ever the result of two different
/// vouchers at one sequence, both signed by the enrolled secure element. That
/// is proof, not suspicion. Nothing is left to weigh, so nothing is left to
/// wait for. The chain cannot measure the loss either, because the second
/// merchant may not have reconnected yet. So a partial slash sized to the loss
/// would have to be sized off chain, by someone, later.
///
/// **The vault's numbers are deliberately left alone.** `stake` and
/// `pending_unstake` are inputs to the offline limit that `redeem_voucher`
/// checks. Zeroing them here would drop the limit to the enrolled floor. Every
/// honest merchant still holding a voucher taken under the staked limit would
/// then be refused, and slashing would *create* the losses it exists to pay
/// for. On a frozen vault those two fields therefore mean "the stake that set
/// the limit merchants were given", not "tokens held". The vault can never
/// stake, unstake or unfreeze, so nothing reads them the other way.
///
/// That leaves the token account as the record of what is still there to
/// slash, and why a second slash finds nothing.
pub fn handle_slash(ctx: Context<Slash>) -> Result<()> {
    require!(
        ctx.accounts.vault.status == VAULT_STATUS_FROZEN,
        NeloError::VaultNotFrozen
    );

    let amount = ctx.accounts.vault_stake_token.amount;
    require!(amount > 0, NeloError::NothingToSlash);

    let owner = ctx.accounts.vault.owner;
    let bump = ctx.accounts.vault.bump;
    let seeds: &[&[u8]] = &[VAULT_SEED, owner.as_ref(), &[bump]];
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.vault_stake_token.to_account_info(),
                mint: ctx.accounts.stake_mint.to_account_info(),
                to: ctx.accounts.reserve_stake_token.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        ctx.accounts.stake_mint.decimals,
    )?;

    emit!(StakeSlashed {
        vault: ctx.accounts.vault.key(),
        amount,
        cranker: ctx.accounts.cranker.key(),
    });

    Ok(())
}
