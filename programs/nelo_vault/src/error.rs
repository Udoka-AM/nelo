use anchor_lang::prelude::*;

#[error_code]
pub enum NeloError {
    #[msg("Voucher version is not supported")]
    BadVoucherVersion,
    #[msg("Voucher is not bound to this vault")]
    VaultMismatch,
    #[msg("Voucher names a different merchant")]
    MerchantMismatch,
    #[msg("Voucher has expired")]
    VoucherExpired,
    #[msg("Voucher amount exceeds the vault floor limit")]
    AboveFloorLimit,
    #[msg("Vault has insufficient locked collateral")]
    InsufficientCollateral,
    #[msg("Vault is frozen")]
    VaultFrozen,
    #[msg("Token mint does not match the mint this vault was enrolled for")]
    MintMismatch,

    // --- replay window ---
    #[msg("Sequence is below the replay window and can no longer be redeemed")]
    SequenceTooOld,
    #[msg("Sequence is beyond the replay window")]
    SequenceTooFarAhead,
    #[msg("Sequence has already been redeemed — double-spend refused")]
    SequenceAlreadyRedeemed,

    // --- precompile introspection ---
    #[msg("Expected the secp256r1 precompile as the first instruction")]
    MissingPrecompileInstruction,
    #[msg("Precompile instruction is malformed")]
    MalformedPrecompileInstruction,
    #[msg("Precompile must verify exactly one signature")]
    ExpectedSingleSignature,
    #[msg("Precompile must reference data inside its own instruction")]
    PrecompileDataNotSelfContained,
    #[msg("Precompile verified a different device key")]
    DeviceKeyMismatch,
    #[msg("Precompile verified different message bytes")]
    SignedMessageMismatch,

    // --- withdraw ---
    #[msg("No withdrawal has been requested")]
    WithdrawNotRequested,
    #[msg("Withdrawal timelock has not elapsed")]
    WithdrawTimelockActive,

    // --- conflict proof ---
    #[msg("Both vouchers must name the same sequence to be a conflict")]
    NotSameSequence,
    #[msg("The two vouchers are identical — that is a replay, not a conflict")]
    NotAConflict,

    #[msg("Arithmetic overflow")]
    Overflow,
}
