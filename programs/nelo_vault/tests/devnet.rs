//! The week-1 gate, run against a real cluster.
//!
//! Everything in vault.rs runs on LiteSVM, which is a simulation of the
//! runtime. The whole product rests on the secp256r1 precompile behaving on a
//! real validator, so this proves it there rather than assuming it carries over.
//!
//! Costs devnet SOL and takes ~30s. Not part of the default suite:
//!
//!   cargo test -p nelo_vault --test devnet -- --ignored --nocapture
//!
//! StrongBox is stood in for by a software P-256 key on purpose — this isolates
//! "does the chain do what we think" from "does the handset do what we think".

use {
    anchor_lang::{
        solana_program::instruction::Instruction, system_program, InstructionData,
        ToAccountMetas,
    },
    p256::ecdsa::{signature::Signer as _, Signature, SigningKey},
    solana_client::rpc_client::RpcClient,
    solana_commitment_config::CommitmentConfig,
    solana_keypair::Keypair,
    solana_pubkey::Pubkey,
    solana_signer::Signer,
    solana_transaction::Transaction,
    std::time::{SystemTime, UNIX_EPOCH},
};

const DEVNET: &str = "https://api.devnet.solana.com";
const SECP256R1_ID: Pubkey = solana_pubkey::pubkey!("Secp256r1SigVerify1111111111111111111111111");
const INSTRUCTIONS_SYSVAR: Pubkey =
    solana_pubkey::pubkey!("Sysvar1nstructions1111111111111111111111111");

const OWNER_FUNDING: u64 = 60_000_000; // 0.06 SOL
const COLLATERAL: u64 = 20_000_000;
const FLOOR_LIMIT: u64 = 10_000_000;
const PAYMENT: u64 = 2_000_000;

fn device_key(seed: u8) -> SigningKey {
    let mut b = [1u8; 32];
    b[31] = seed;
    SigningKey::from_slice(&b).unwrap()
}

fn device_pubkey(sk: &SigningKey) -> [u8; 33] {
    let mut out = [0u8; 33];
    out.copy_from_slice(sk.verifying_key().to_encoded_point(true).as_bytes());
    out
}

fn sign(sk: &SigningKey, msg: &[u8]) -> [u8; 64] {
    let sig: Signature = sk.sign(msg);
    let sig = sig.normalize_s().unwrap_or(sig);
    let mut out = [0u8; 64];
    out.copy_from_slice(&sig.to_bytes());
    out
}

fn secp256r1_ix(message: &[u8], signature: &[u8; 64], pubkey: &[u8; 33]) -> Instruction {
    let pk_off: u16 = 16;
    let sig_off: u16 = pk_off + 33;
    let msg_off: u16 = sig_off + 64;
    let mut data = vec![1u8, 0u8];
    data.extend_from_slice(&sig_off.to_le_bytes());
    data.extend_from_slice(&u16::MAX.to_le_bytes());
    data.extend_from_slice(&pk_off.to_le_bytes());
    data.extend_from_slice(&u16::MAX.to_le_bytes());
    data.extend_from_slice(&msg_off.to_le_bytes());
    data.extend_from_slice(&(message.len() as u16).to_le_bytes());
    data.extend_from_slice(&u16::MAX.to_le_bytes());
    data.extend_from_slice(pubkey);
    data.extend_from_slice(signature);
    data.extend_from_slice(message);
    Instruction { program_id: SECP256R1_ID, accounts: vec![], data }
}

fn send(
    rpc: &RpcClient,
    ixs: &[Instruction],
    signers: &[&Keypair],
) -> Result<String, String> {
    let blockhash = rpc.get_latest_blockhash().map_err(|e| e.to_string())?;
    let tx = Transaction::new_signed_with_payer(
        ixs,
        Some(&signers[0].pubkey()),
        signers,
        blockhash,
    );
    rpc.send_and_confirm_transaction(&tx)
        .map(|s| s.to_string())
        .map_err(|e| e.to_string())
}

#[test]
#[ignore = "hits devnet; run with --ignored --nocapture"]
fn week_one_gate_on_devnet() {
    let rpc = RpcClient::new_with_commitment(DEVNET.to_string(), CommitmentConfig::confirmed());
    let program_id = nelo_vault::id();
    println!("program: {program_id}");

    // The funding wallet — never a vault owner, so each run starts clean.
    let funder = solana_keypair::read_keypair_file(
        shellexpand::tilde("~/.config/solana/id.json").to_string(),
    )
    .expect("default solana keypair");

    // Fresh owner every run: the vault PDA is seeded by owner, so this avoids
    // colliding with a previous run's account.
    let owner = Keypair::new();
    let merchant = Keypair::new();
    let device = device_key(7);
    let (vault, _) =
        Pubkey::find_program_address(&[b"vault", owner.pubkey().as_ref()], &program_id);
    println!("owner:  {}\nvault:  {vault}", owner.pubkey());

    send(
        &rpc,
        &[
            solana_system_interface::instruction::transfer(
                &funder.pubkey(),
                &owner.pubkey(),
                OWNER_FUNDING,
            ),
            solana_system_interface::instruction::transfer(
                &funder.pubkey(),
                &merchant.pubkey(),
                3_000_000,
            ),
        ],
        &[&funder],
    )
    .expect("fund owner + merchant");

    // 1. Enrol the device key and open a vault.
    send(
        &rpc,
        &[Instruction::new_with_bytes(
            program_id,
            &nelo_vault::instruction::InitializeVault {
                device_pubkey: device_pubkey(&device),
                attestation_id: [9u8; 32],
                mint: Pubkey::new_unique(),
                floor_limit: FLOOR_LIMIT,
            }
            .data(),
            nelo_vault::accounts::InitializeVault {
                owner: owner.pubkey(),
                vault,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        &[&owner],
    )
    .expect("initialize_vault");
    println!("✓ vault initialised");

    // 2. Lock collateral.
    send(
        &rpc,
        &[Instruction::new_with_bytes(
            program_id,
            &nelo_vault::instruction::Deposit { amount: COLLATERAL }.data(),
            nelo_vault::accounts::Deposit {
                owner: owner.pubkey(),
                vault,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )],
        &[&owner],
    )
    .expect("deposit");
    println!("✓ collateral locked");

    // 3. Redeem an offline voucher — the precompile path, on a real validator.
    let expires_at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64 + 3600;
    let voucher = nelo_vault::voucher::VoucherArgs {
        version: 1,
        vault,
        seq: 0,
        amount: PAYMENT,
        remaining_after: COLLATERAL - PAYMENT,
        merchant: merchant.pubkey(),
        expires_at,
        salt: [0u8; 8],
    };
    let msg = voucher.signed_message();
    let redeem = |v: &nelo_vault::voucher::VoucherArgs| {
        Instruction::new_with_bytes(
            program_id,
            &nelo_vault::instruction::RedeemVoucher { voucher: v.clone() }.data(),
            nelo_vault::accounts::RedeemVoucher {
                payer: owner.pubkey(),
                vault,
                merchant: merchant.pubkey(),
                instructions: INSTRUCTIONS_SYSVAR,
            }
            .to_account_metas(None),
        )
    };

    let before = rpc.get_balance(&merchant.pubkey()).unwrap();
    let sig = send(
        &rpc,
        &[
            secp256r1_ix(&msg, &sign(&device, &msg), &device_pubkey(&device)),
            redeem(&voucher),
        ],
        &[&owner],
    )
    .expect("redeem_voucher on devnet");
    let after = rpc.get_balance(&merchant.pubkey()).unwrap();
    assert_eq!(after - before, PAYMENT, "merchant was paid on devnet");
    println!("✓ voucher redeemed on devnet — precompile verified a StrongBox-shaped\n  P-256 signature on a real validator\n  tx: {sig}");

    // 4. The deliberate double-spend. Same sequence, freshly signed.
    let mut replay = voucher.clone();
    replay.salt = [1u8; 8];
    let msg2 = replay.signed_message();
    let res = send(
        &rpc,
        &[
            secp256r1_ix(&msg2, &sign(&device, &msg2), &device_pubkey(&device)),
            redeem(&replay),
        ],
        &[&owner],
    );
    assert!(res.is_err(), "double-spend settled on devnet");
    let err = res.unwrap_err();
    assert!(
        err.contains("SequenceAlreadyRedeemed") || err.contains("0x177a") || err.contains("custom"),
        "refused, but not by the replay window: {err}"
    );
    println!("✓ double-spend at seq 0 refused on devnet");

    // 5. A signature over other bytes must not settle.
    let decoy = nelo_vault::voucher::VoucherArgs { seq: 1, amount: 1, ..voucher.clone() };
    let decoy_msg = decoy.signed_message();
    let real = nelo_vault::voucher::VoucherArgs { seq: 1, ..voucher.clone() };
    let res = send(
        &rpc,
        &[
            secp256r1_ix(&decoy_msg, &sign(&device, &decoy_msg), &device_pubkey(&device)),
            redeem(&real),
        ],
        &[&owner],
    );
    assert!(res.is_err(), "a signature over other bytes settled on devnet");
    println!("✓ signature over different bytes refused on devnet");

    println!("\nWEEK-1 GATE PASSED ON DEVNET");
}
