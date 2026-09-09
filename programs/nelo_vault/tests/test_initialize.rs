//! Program tests run against LiteSVM — no local validator, no TypeScript client.
//!
//! Week one's real tests live here: the replay window accepting out-of-order
//! sequences, and a deliberate double-spend that the program must reject. This
//! file is the harness those get written into.

use {
    anchor_lang::{
        solana_program::instruction::Instruction, InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

/// Loads the compiled program. `anchor test` builds the `.so` before running
/// `cargo test`, so this path is populated by the time the test binary runs.
fn load_program(svm: &mut LiteSVM) {
    let bytes = include_bytes!(concat!(
        env!("CARGO_TARGET_TMPDIR"),
        "/../deploy/nelo_vault.so"
    ));
    svm.add_program(nelo_vault::id(), bytes).unwrap();
}

#[test]
fn test_initialize() {
    let mut svm = LiteSVM::new();
    load_program(&mut svm);

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();

    let instruction = Instruction::new_with_bytes(
        nelo_vault::id(),
        &nelo_vault::instruction::Initialize {}.data(),
        nelo_vault::accounts::Initialize {}.to_account_metas(None),
    );

    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[instruction], Some(&payer.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&payer]).unwrap();

    assert!(svm.send_transaction(tx).is_ok());
}
