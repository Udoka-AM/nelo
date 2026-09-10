use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Vault {
    /// The payer who funded this vault.
    pub owner: Pubkey,
    /// Settlement mint. Carried from enrolment; the SPL leg lands in week 2,
    /// so week-1 collateral is native lamports held by this PDA.
    pub mint: Pubkey,
    /// P-256 public key of the device secure element, SEC1 compressed.
    pub device_pubkey: [u8; 33],
    /// Hash of the verified StrongBox attestation chain.
    pub attestation_id: [u8; 32],
    /// Locked collateral, in lamports for now.
    pub balance: u64,
    /// Lowest sequence still tracked by the replay window.
    pub seq_base: u64,
    /// 128-slot sliding replay window, one bit per sequence from `seq_base`.
    pub seq_bitmap: u128,
    /// Maximum value of a single offline voucher.
    pub floor_limit: u64,
    /// Unix seconds after which `withdraw` is permitted. 0 = no request open.
    pub unlock_at: i64,
    pub status: u8,
    pub bump: u8,
}

impl Vault {
    pub fn is_active(&self) -> bool {
        self.status == crate::constants::VAULT_STATUS_ACTIVE
    }
}
