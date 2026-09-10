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
