//! The program's error codes, as the chain reports them.
//!
//! A merchant's settle queue decides what a failed redemption *means* — paid to
//! someone else, worth retrying, or a bug — from nothing but the number in
//! `InstructionError(1, Custom(n))`. Anchor numbers errors by their position in
//! `NeloError`, so inserting a variant anywhere but the end renumbers every one
//! after it, and a queue that still believes the old numbers retries a voucher
//! that is lost, or gives up on one that is merely waiting.
//!
//! So the numbers are generated here and asserted on both sides. Regenerate with
//!
//!   cargo test -p nelo_vault --test error_vectors -- --ignored --nocapture emit
//!
//! and write the output to packages/queue/vectors/program-errors-v1.json.

use {
    nelo_vault::error::NeloError,
    serde_json::{Map, Value},
};

const VECTORS: &str = include_str!("../../../packages/queue/vectors/program-errors-v1.json");

/// Every variant, in declaration order.
///
/// One gap: nothing here notices a variant *appended* to `NeloError` and left
/// out of this list, because Anchor gives no way to walk an enum's codes. That
/// is the safe gap. Its code is one the queue has never heard of, and the queue
/// holds an unknown code for a person rather than retrying or giving up. A
/// variant *inserted* anywhere else renumbers the ones after it, and that
/// fails below.
fn errors() -> Vec<(&'static str, NeloError)> {
    vec![
        ("BadVoucherVersion", NeloError::BadVoucherVersion),
        ("VaultMismatch", NeloError::VaultMismatch),
        ("MerchantMismatch", NeloError::MerchantMismatch),
        ("VoucherExpired", NeloError::VoucherExpired),
        ("AboveFloorLimit", NeloError::AboveFloorLimit),
        ("InsufficientCollateral", NeloError::InsufficientCollateral),
        ("VaultFrozen", NeloError::VaultFrozen),
        ("MintMismatch", NeloError::MintMismatch),
        ("SequenceTooOld", NeloError::SequenceTooOld),
        ("SequenceTooFarAhead", NeloError::SequenceTooFarAhead),
        (
            "SequenceAlreadyRedeemed",
            NeloError::SequenceAlreadyRedeemed,
        ),
        (
            "MissingPrecompileInstruction",
            NeloError::MissingPrecompileInstruction,
        ),
        (
            "MalformedPrecompileInstruction",
            NeloError::MalformedPrecompileInstruction,
        ),
        (
            "ExpectedSingleSignature",
            NeloError::ExpectedSingleSignature,
        ),
        (
            "PrecompileDataNotSelfContained",
            NeloError::PrecompileDataNotSelfContained,
        ),
        ("DeviceKeyMismatch", NeloError::DeviceKeyMismatch),
        ("SignedMessageMismatch", NeloError::SignedMessageMismatch),
        ("WithdrawNotRequested", NeloError::WithdrawNotRequested),
        ("WithdrawTimelockActive", NeloError::WithdrawTimelockActive),
        ("NotSameSequence", NeloError::NotSameSequence),
        ("NotAConflict", NeloError::NotAConflict),
        ("BadRiskParams", NeloError::BadRiskParams),
        ("NotRiskAuthority", NeloError::NotRiskAuthority),
        ("ReputationOutOfRange", NeloError::ReputationOutOfRange),
        ("CooldownTooShort", NeloError::CooldownTooShort),
        ("StakeMintMismatch", NeloError::StakeMintMismatch),
        ("InsufficientStake", NeloError::InsufficientStake),
        ("UnstakeNotRequested", NeloError::UnstakeNotRequested),
        ("UnstakeCooldownActive", NeloError::UnstakeCooldownActive),
        ("ZeroAmount", NeloError::ZeroAmount),
        ("Overflow", NeloError::Overflow),
        ("VaultNotFrozen", NeloError::VaultNotFrozen),
        ("NothingToSlash", NeloError::NothingToSlash),
    ]
}

fn table() -> Value {
    let mut map = Map::new();
    for (name, error) in errors() {
        map.insert(name.to_string(), Value::from(u32::from(error)));
    }
    Value::Object(map)
}

#[test]
#[ignore = "generator, not a check — run with --ignored --nocapture"]
fn emit() {
    println!("{}", serde_json::to_string_pretty(&table()).unwrap());
}

#[test]
fn golden_vectors_match() {
    let stored: Value =
        serde_json::from_str(VECTORS).expect("program-errors-v1.json is valid JSON");
    assert_eq!(
        stored,
        table(),
        "packages/queue/vectors/program-errors-v1.json no longer matches NeloError. \
         Regenerate with the command at the top of this file — and expect the \
         queue's classification tests to fail until they agree."
    );
}

/// Contiguous from Anchor's offset, in the order listed, and each name is the
/// variant's own — so a reordering, an insertion or a mislabel fails here even
/// before the stored vectors are compared.
#[test]
fn every_code_is_accounted_for() {
    let codes: Vec<u32> = errors().iter().map(|(_, e)| u32::from(e.clone())).collect();
    let expected: Vec<u32> = (0..codes.len() as u32).map(|i| 6000 + i).collect();
    assert_eq!(codes, expected, "listed in declaration order, none skipped");
    for (name, error) in errors() {
        assert_eq!(error.name(), name, "the listed name is the variant's own");
    }
}
