use anchor_lang::prelude::*;

/// PDA seed for a payer's vault.
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";

/// Voucher wire-format version. Anything else is rejected outright.
pub const VOUCHER_VERSION: u8 = 1;

/// Bytes 0..105 of the voucher are what the secure element signs.
pub const SIGNED_LEN: usize = 105;

/// Sliding replay window, in sequence slots. Matches `Vault::seq_bitmap` width.
pub const REPLAY_WINDOW: u64 = 128;

/// Delay between `request_withdraw` and `withdraw`. Must exceed the realistic
/// offline window, or the withdraw-before-anyone-reconnects attack is trivial.
pub const WITHDRAW_TIMELOCK_SECONDS: i64 = 24 * 60 * 60;

pub const VAULT_STATUS_ACTIVE: u8 = 0;
pub const VAULT_STATUS_FROZEN: u8 = 1;

// ---- Trust Stake ----

/// PDA seed for the platform-wide risk configuration.
#[constant]
pub const RISK_CONFIG_SEED: &[u8] = b"risk";

/// PDA seed for a vault's staked-collateral token account authority.
#[constant]
pub const STAKE_SEED: &[u8] = b"stake";

/// One basis point scale. Every ratio in the curve is fixed-point on this.
pub const BPS: u128 = 10_000;

/// `stake_price` is quoted per this many stake base units. Quoting per-unit
/// would round a sub-cent token to zero; quoting per 10^9 keeps the precision
/// where the arithmetic can see it.
pub const VALUATION_UNIT: u128 = 1_000_000_000;

/// Neutral reputation. A vault opens here, so the curve is a no-op until the
/// risk authority has something to say.
pub const REPUTATION_NEUTRAL_BPS: u16 = 10_000;

/// Ceiling on the published reputation multiplier. The hard cap already bounds
/// the limit; this bounds the *input*, so a wrong or compromised risk authority
/// cannot quietly lift every merchant at once.
pub const REPUTATION_MAX_BPS: u16 = 20_000;

/// Floor on the unstake cooldown.
///
/// The cooldown must exceed the maximum offline settlement window, or a payer
/// can unstake to escape a loss that is still in flight — vouchers signed
/// before the request have not been presented yet. The delay *is* the
/// settlement horizon, which is why it is pinned to the same constant as the
/// collateral timelock rather than picked independently.
pub const MIN_UNSTAKE_COOLDOWN_SECONDS: i64 = WITHDRAW_TIMELOCK_SECONDS;

/// `Secp256r1SigVerify1111111111111111111111111`
pub use solana_sdk_ids::secp256r1_program::ID as SECP256R1_PROGRAM_ID;

// ---- secp256r1 precompile instruction-data layout ----
// [0]      num_signatures : u8
// [1]      padding        : u8
// [2..16]  Secp256r1SignatureOffsets (7 x u16, little-endian)
// [16..]   pubkey(33) || signature(64) || message(..)
pub const SIG_OFFSETS_START: usize = 2;
pub const SIG_OFFSETS_SERIALIZED_SIZE: usize = 14;
pub const PRECOMPILE_DATA_START: usize = SIG_OFFSETS_START + SIG_OFFSETS_SERIALIZED_SIZE;
pub const COMPRESSED_PUBKEY_SERIALIZED_SIZE: usize = 33;
pub const SIGNATURE_SERIALIZED_SIZE: usize = 64;

/// The precompile instruction we introspect must be first in the transaction.
pub const PRECOMPILE_IX_INDEX: usize = 0;

/// A conflict proof carries two signatures, so it needs two precompile
/// instructions ahead of it.
pub const CONFLICT_IX_INDEX_A: usize = 0;
pub const CONFLICT_IX_INDEX_B: usize = 1;
