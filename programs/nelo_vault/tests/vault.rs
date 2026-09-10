//! Week-1 gate for the trust model.
//!
//! Order is deliberate. The first test in this file is the one that must fail:
//! a *valid* P-256 signature over *different* bytes has to be rejected. Get the
//! precompile offsets wrong and every positive test below still passes while
//! the program verifies nothing at all.

use {
    anchor_lang::{
        prelude::Clock,
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    nelo_vault::{state::Vault, voucher::VoucherArgs},
    p256::ecdsa::{signature::Signer as P256Signer, Signature, SigningKey},
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_pubkey::Pubkey,
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const SECP256R1_ID: Pubkey =
    solana_pubkey::pubkey!("Secp256r1SigVerify1111111111111111111111111");
const INSTRUCTIONS_SYSVAR: Pubkey =
    solana_pubkey::pubkey!("Sysvar1nstructions1111111111111111111111111");

const LAMPORTS: u64 = 1_000_000_000;
const FLOOR_LIMIT: u64 = 50_000_000;
const COLLATERAL: u64 = 500_000_000;
const FAR_FUTURE: i64 = 4_102_444_800; // 2100-01-01
/// litesvm starts at unix epoch 0, where nothing can be "in the past".
const NOW: i64 = 1_789_000_000; // ~Sep 2026

// ---------------------------------------------------------------- harness ---

struct Ctx {
    svm: LiteSVM,
    owner: Keypair,
    merchant: Keypair,
    vault: Pubkey,
    device: SigningKey,
}

/// Deterministic device key, so a failure reproduces exactly.
fn device_key(seed: u8) -> SigningKey {
    let mut bytes = [1u8; 32];
    bytes[31] = seed;
    SigningKey::from_slice(&bytes).unwrap()
}

fn device_pubkey(sk: &SigningKey) -> [u8; 33] {
    let point = sk.verifying_key().to_encoded_point(true);
    let mut out = [0u8; 33];
    out.copy_from_slice(point.as_bytes());
    out
}

/// Sign, then normalise to low-S. Android returns DER and a possibly high S;
/// the precompile wants 64 raw bytes, r‖s, low-S.
fn sign(sk: &SigningKey, message: &[u8]) -> [u8; 64] {
    let sig: Signature = sk.sign(message);
    let sig = sig.normalize_s().unwrap_or(sig);
    let mut out = [0u8; 64];
    out.copy_from_slice(&sig.to_bytes());
    out
}

/// Hand-built so the offsets under test are the ones the program parses,
/// rather than whatever a helper crate happens to emit.
fn secp256r1_ix(message: &[u8], signature: &[u8; 64], pubkey: &[u8; 33]) -> Instruction {
    let pk_off: u16 = 16;
    let sig_off: u16 = pk_off + 33;
    let msg_off: u16 = sig_off + 64;

    let mut data = Vec::new();
    data.push(1u8); // one signature
    data.push(0u8); // padding
    data.extend_from_slice(&sig_off.to_le_bytes());
    data.extend_from_slice(&u16::MAX.to_le_bytes()); // signature lives here
    data.extend_from_slice(&pk_off.to_le_bytes());
    data.extend_from_slice(&u16::MAX.to_le_bytes()); // pubkey lives here
    data.extend_from_slice(&msg_off.to_le_bytes());
    data.extend_from_slice(&(message.len() as u16).to_le_bytes());
    data.extend_from_slice(&u16::MAX.to_le_bytes()); // message lives here
    data.extend_from_slice(pubkey);
    data.extend_from_slice(signature);
    data.extend_from_slice(message);

    Instruction { program_id: SECP256R1_ID, accounts: vec![], data }
}

fn send(ctx: &mut Ctx, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), String> {
    // Without this, replaying the same instruction in one test yields an
    // identical signature and litesvm refuses it as AlreadyProcessed — which
    // would mask the program-level rejection we are actually asserting.
    ctx.svm.expire_blockhash();
    let blockhash = ctx.svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&signers[0].pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers)
        .map_err(|e| e.to_string())?;
    ctx.svm
        .send_transaction(tx)
        .map(|_| ())
        .map_err(|e| format!("{:?} {}", e.err, e.meta.logs.join(" | ")))
}

fn setup() -> Ctx {
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(
        env!("CARGO_TARGET_TMPDIR"),
        "/../deploy/nelo_vault.so"
    ));
    svm.add_program(nelo_vault::id(), bytes).unwrap();

    let owner = Keypair::new();
    let merchant = Keypair::new();
    svm.airdrop(&owner.pubkey(), 10 * LAMPORTS).unwrap();
    // The merchant must exist as a system account to be a payee.
    svm.airdrop(&merchant.pubkey(), LAMPORTS / 100).unwrap();

    let (vault, _) =
        Pubkey::find_program_address(&[b"vault", owner.pubkey().as_ref()], &nelo_vault::id());
    let device = device_key(7);

    let mut ctx = Ctx { svm, owner, merchant, vault, device };
    let mut clock: Clock = ctx.svm.get_sysvar();
    clock.unix_timestamp = NOW;
    ctx.svm.set_sysvar(&clock);

    let init = Instruction::new_with_bytes(
        nelo_vault::id(),
        &nelo_vault::instruction::InitializeVault {
            device_pubkey: device_pubkey(&ctx.device),
            attestation_id: [9u8; 32],
            mint: Pubkey::new_unique(),
            floor_limit: FLOOR_LIMIT,
        }
        .data(),
        nelo_vault::accounts::InitializeVault {
            owner: ctx.owner.pubkey(),
            vault: ctx.vault,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    let owner = ctx.owner.insecure_clone();
    send(&mut ctx, &[init], &[&owner]).expect("initialize_vault");

    let deposit = Instruction::new_with_bytes(
        nelo_vault::id(),
        &nelo_vault::instruction::Deposit { amount: COLLATERAL }.data(),
        nelo_vault::accounts::Deposit {
            owner: ctx.owner.pubkey(),
            vault: ctx.vault,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    send(&mut ctx, &[deposit], &[&owner]).expect("deposit");

    ctx
}

fn voucher(ctx: &Ctx, seq: u64, amount: u64) -> VoucherArgs {
    VoucherArgs {
        version: 1,
        vault: ctx.vault,
        seq,
        amount,
        remaining_after: COLLATERAL.saturating_sub(amount),
        merchant: ctx.merchant.pubkey(),
        expires_at: FAR_FUTURE,
        salt: [0u8; 8],
    }
}

fn redeem_ix(ctx: &Ctx, v: &VoucherArgs) -> Instruction {
    Instruction::new_with_bytes(
        nelo_vault::id(),
        &nelo_vault::instruction::RedeemVoucher { voucher: v.clone() }.data(),
        nelo_vault::accounts::RedeemVoucher {
            payer: ctx.owner.pubkey(),
            vault: ctx.vault,
            merchant: ctx.merchant.pubkey(),
            instructions: INSTRUCTIONS_SYSVAR,
        }
        .to_account_metas(None),
    )
}

/// The pair of instructions a merchant broadcasts on reconnect: precompile
/// first, redemption second.
fn redeem(ctx: &mut Ctx, v: &VoucherArgs, sk: &SigningKey) -> Result<(), String> {
    let msg = v.signed_message();
    let sig = sign(sk, &msg);
    let ixs = [secp256r1_ix(&msg, &sig, &device_pubkey(sk)), redeem_ix(ctx, v)];
    let owner = ctx.owner.insecure_clone();
    send(ctx, &ixs, &[&owner])
}

fn vault_state(ctx: &Ctx) -> Vault {
    let acct = ctx.svm.get_account(&ctx.vault).unwrap();
    Vault::try_deserialize(&mut acct.data.as_slice()).unwrap()
}

fn warp(ctx: &mut Ctx, seconds: i64) {
    let mut clock: Clock = ctx.svm.get_sysvar();
    clock.unix_timestamp += seconds;
    ctx.svm.set_sysvar(&clock);
}

// ------------------------------------------------------- the negative test ---

/// Write this one first. A signature that is cryptographically valid, but over
/// bytes that are not the voucher being redeemed, must not settle anything.
#[test]
fn rejects_signature_over_other_bytes() {
    let mut ctx = setup();

    let real = voucher(&ctx, 0, 10_000_000);
    let decoy = voucher(&ctx, 0, 1); // signed, but not what we submit

    let signed_bytes = decoy.signed_message();
    let sig = sign(&ctx.device, &signed_bytes);
    let pk = device_pubkey(&ctx.device);

    // Precompile verifies the decoy happily; the program must still refuse,
    // because those are not the bytes of the voucher in instruction 1.
    let ixs = [secp256r1_ix(&signed_bytes, &sig, &pk), redeem_ix(&ctx, &real)];
    let owner = ctx.owner.insecure_clone();
    let res = send(&mut ctx, &ixs, &[&owner]);

    assert!(res.is_err(), "a signature over other bytes must not redeem");
    assert!(
        res.unwrap_err().contains("SignedMessageMismatch"),
        "must fail on the message check, not incidentally"
    );
    assert_eq!(vault_state(&ctx).balance, COLLATERAL, "nothing moved");
}

/// The other half of the same hole: a valid signature from a key that is not
/// the one enrolled on this vault.
#[test]
fn rejects_wrong_device_key() {
    let mut ctx = setup();
    let attacker = device_key(99);

    let v = voucher(&ctx, 0, 10_000_000);
    let res = redeem(&mut ctx, &v, &attacker);

    assert!(res.is_err(), "an unenrolled key must not redeem");
    assert!(res.unwrap_err().contains("DeviceKeyMismatch"));
    assert_eq!(vault_state(&ctx).balance, COLLATERAL);
}

/// A precompile entry that points at a *different* instruction for its data
/// would let an attacker have one set of bytes verified and another checked.
#[test]
fn rejects_precompile_data_from_another_instruction() {
    let mut ctx = setup();
    let v = voucher(&ctx, 0, 10_000_000);
    let msg = v.signed_message();
    let sig = sign(&ctx.device, &msg);

    let mut precompile = secp256r1_ix(&msg, &sig, &device_pubkey(&ctx.device));
    // message_instruction_index sits at data[14..16]; point it elsewhere.
    precompile.data[14..16].copy_from_slice(&1u16.to_le_bytes());

    let owner = ctx.owner.insecure_clone();
    let ixs = [precompile, redeem_ix(&ctx, &v)];
    let res = send(&mut ctx, &ixs, &[&owner]);
    assert!(res.is_err(), "cross-instruction data must be refused");
}

// -------------------------------------------------------- the happy path ---

#[test]
fn redeems_a_valid_voucher() {
    let mut ctx = setup();
    let amount = 10_000_000;
    let before = ctx.svm.get_account(&ctx.merchant.pubkey()).unwrap().lamports;

    let v = voucher(&ctx, 0, amount);
    let device = ctx.device.clone();
    redeem(&mut ctx, &v, &device).expect("valid voucher should redeem");

    let after = ctx.svm.get_account(&ctx.merchant.pubkey()).unwrap().lamports;
    assert_eq!(after - before, amount, "merchant was paid");

    let state = vault_state(&ctx);
    assert_eq!(state.balance, COLLATERAL - amount);
    assert_eq!(state.seq_base, 1, "window advanced past slot 0");
}

#[test]
fn rejects_amount_above_floor_limit() {
    let mut ctx = setup();
    let v = voucher(&ctx, 0, FLOOR_LIMIT + 1);
    let device = ctx.device.clone();
    let res = redeem(&mut ctx, &v, &device);
    assert!(res.is_err());
    assert!(res.unwrap_err().contains("AboveFloorLimit"));
}

#[test]
fn rejects_expired_voucher() {
    let mut ctx = setup();
    let mut v = voucher(&ctx, 0, 10_000_000);
    v.expires_at = NOW - 60; // a minute ago
    let device = ctx.device.clone();
    let res = redeem(&mut ctx, &v, &device);
    assert!(res.is_err());
    assert!(res.unwrap_err().contains("VoucherExpired"));
}

// ------------------------------------------------------- the replay window ---

/// The case a single `last_seq` counter gets wrong. Merchant B holds voucher 6
/// and reconnects before merchant A, who holds voucher 5. Both must settle.
#[test]
fn replay_window_accepts_out_of_order() {
    let mut ctx = setup();
    let device = ctx.device.clone();

    let later = voucher(&ctx, 6, 1_000_000);
    redeem(&mut ctx, &later, &device).expect("voucher 6 redeems first");
    assert_eq!(
        vault_state(&ctx).seq_base,
        0,
        "base holds at 0 while slot 0 is unfilled"
    );

    let earlier = voucher(&ctx, 5, 2_000_000);
    redeem(&mut ctx, &earlier, &device).expect("voucher 5 must still redeem after 6");

    let state = vault_state(&ctx);
    assert_eq!(state.balance, COLLATERAL - 3_000_000, "both were paid");
}

/// Filling the bottom of the window slides it forward.
#[test]
fn window_base_advances_over_contiguous_slots() {
    let mut ctx = setup();
    let device = ctx.device.clone();

    for seq in [1u64, 2, 0] {
        let v = voucher(&ctx, seq, 1_000_000);
        redeem(&mut ctx, &v, &device).unwrap_or_else(|e| panic!("seq {seq}: {e}"));
    }

    assert_eq!(
        vault_state(&ctx).seq_base,
        3,
        "0,1,2 contiguous — base jumps to 3"
    );
}

#[test]
fn rejects_sequence_beyond_the_window() {
    let mut ctx = setup();
    let v = voucher(&ctx, 128, 1_000_000);
    let device = ctx.device.clone();
    let res = redeem(&mut ctx, &v, &device);
    assert!(res.is_err());
    assert!(res.unwrap_err().contains("SequenceTooFarAhead"));
}

// ------------------------------------------------------ the double-spend ---

/// The deliberate double-spend. One vault, one sequence, two merchants. The
/// second redemption must fail and must move no money.
#[test]
fn double_spend_is_refused() {
    let mut ctx = setup();
    let device = ctx.device.clone();
    let amount = 10_000_000;

    let first = voucher(&ctx, 3, amount);
    redeem(&mut ctx, &first, &device).expect("first spend settles");

    let balance_after_first = vault_state(&ctx).balance;
    let merchant_after_first = ctx.svm.get_account(&ctx.merchant.pubkey()).unwrap().lamports;

    // Same sequence, freshly signed, different salt — a genuinely new voucher
    // that reuses a spent slot. This is the attack.
    let mut second = voucher(&ctx, 3, amount);
    second.salt = [1u8; 8];
    let res = redeem(&mut ctx, &second, &device);

    assert!(res.is_err(), "the second spend at seq 3 must be refused");
    assert!(res.unwrap_err().contains("SequenceAlreadyRedeemed"));
    assert_eq!(vault_state(&ctx).balance, balance_after_first, "no double debit");
    assert_eq!(
        ctx.svm.get_account(&ctx.merchant.pubkey()).unwrap().lamports,
        merchant_after_first,
        "no second payout"
    );
}

// ----------------------------------------------------- the withdraw timelock ---

#[test]
fn withdraw_requires_a_request() {
    let mut ctx = setup();
    let owner = ctx.owner.insecure_clone();
    let ix = Instruction::new_with_bytes(
        nelo_vault::id(),
        &nelo_vault::instruction::Withdraw { amount: 1_000 }.data(),
        nelo_vault::accounts::Withdraw { owner: owner.pubkey(), vault: ctx.vault }
            .to_account_metas(None),
    );
    let res = send(&mut ctx, &[ix], &[&owner]);
    assert!(res.is_err());
    assert!(res.unwrap_err().contains("WithdrawNotRequested"));
}

/// Go offline, sign vouchers at every stall, get home, withdraw before anyone
/// reconnects. The timelock is what closes it.
#[test]
fn withdraw_blocked_until_timelock_elapses() {
    let mut ctx = setup();
    let owner = ctx.owner.insecure_clone();

    let request = Instruction::new_with_bytes(
        nelo_vault::id(),
        &nelo_vault::instruction::RequestWithdraw {}.data(),
        nelo_vault::accounts::RequestWithdraw { owner: owner.pubkey(), vault: ctx.vault }
            .to_account_metas(None),
    );
    send(&mut ctx, &[request], &[&owner]).expect("request_withdraw");

    let (owner_pk, vault_pk) = (owner.pubkey(), ctx.vault);
    let withdraw = move || {
        Instruction::new_with_bytes(
            nelo_vault::id(),
            &nelo_vault::instruction::Withdraw { amount: 100_000_000 }.data(),
            nelo_vault::accounts::Withdraw { owner: owner_pk, vault: vault_pk }
                .to_account_metas(None),
        )
    };

    warp(&mut ctx, 23 * 60 * 60); // 23h — still inside the 24h delay
    let res = send(&mut ctx, &[withdraw()], &[&owner]);
    assert!(res.is_err(), "withdrawing inside the timelock must fail");
    assert!(res.unwrap_err().contains("WithdrawTimelockActive"));

    warp(&mut ctx, 2 * 60 * 60); // past 24h
    send(&mut ctx, &[withdraw()], &[&owner]).expect("withdraw after the timelock");
    assert_eq!(vault_state(&ctx).balance, COLLATERAL - 100_000_000);
}

/// The timelock blocks the payer's exit, not the merchants holding vouchers.
#[test]
fn vouchers_still_redeem_during_the_timelock() {
    let mut ctx = setup();
    let owner = ctx.owner.insecure_clone();

    let request = Instruction::new_with_bytes(
        nelo_vault::id(),
        &nelo_vault::instruction::RequestWithdraw {}.data(),
        nelo_vault::accounts::RequestWithdraw { owner: owner.pubkey(), vault: ctx.vault }
            .to_account_metas(None),
    );
    send(&mut ctx, &[request], &[&owner]).expect("request_withdraw");

    warp(&mut ctx, 60 * 60);
    let v = voucher(&ctx, 0, 5_000_000);
    let device = ctx.device.clone();
    redeem(&mut ctx, &v, &device)
        .expect("a merchant reconnecting mid-timelock must still be paid");
}

// ------------------------------------------------------- the conflict freeze ---

fn report_conflict(
    ctx: &mut Ctx,
    a: &VoucherArgs,
    b: &VoucherArgs,
    sk_a: &SigningKey,
    sk_b: &SigningKey,
) -> Result<(), String> {
    let (msg_a, msg_b) = (a.signed_message(), b.signed_message());
    let ix = Instruction::new_with_bytes(
        nelo_vault::id(),
        &nelo_vault::instruction::ReportConflict { voucher_a: a.clone(), voucher_b: b.clone() }
            .data(),
        nelo_vault::accounts::ReportConflict {
            reporter: ctx.owner.pubkey(),
            vault: ctx.vault,
            instructions: INSTRUCTIONS_SYSVAR,
        }
        .to_account_metas(None),
    );
    let ixs = [
        secp256r1_ix(&msg_a, &sign(sk_a, &msg_a), &device_pubkey(sk_a)),
        secp256r1_ix(&msg_b, &sign(sk_b, &msg_b), &device_pubkey(sk_b)),
        ix,
    ];
    let owner = ctx.owner.insecure_clone();
    send(ctx, &ixs, &[&owner])
}

/// Two different vouchers at the same sequence, both signed by the enrolled
/// device. An honest secure element never produces that pair.
#[test]
fn conflict_proof_freezes_the_vault() {
    let mut ctx = setup();
    let device = ctx.device.clone();

    let a = voucher(&ctx, 4, 10_000_000);
    let mut b = voucher(&ctx, 4, 20_000_000);
    b.salt = [2u8; 8];

    assert_eq!(vault_state(&ctx).status, 0, "starts active");
    report_conflict(&mut ctx, &a, &b, &device, &device).expect("proof should be accepted");
    assert_eq!(vault_state(&ctx).status, 1, "vault is frozen");
}

/// The same voucher submitted twice is a replay, not payer fraud. It must not
/// freeze anyone — otherwise replaying a voucher you legitimately hold is a
/// denial-of-service against the payer.
#[test]
fn conflict_proof_rejects_identical_vouchers() {
    let mut ctx = setup();
    let device = ctx.device.clone();
    let a = voucher(&ctx, 4, 10_000_000);

    let res = report_conflict(&mut ctx, &a, &a.clone(), &device, &device);
    assert!(res.is_err());
    assert!(res.unwrap_err().contains("NotAConflict"));
    assert_eq!(vault_state(&ctx).status, 0, "still active");
}

#[test]
fn conflict_proof_rejects_different_sequences() {
    let mut ctx = setup();
    let device = ctx.device.clone();
    let a = voucher(&ctx, 4, 10_000_000);
    let b = voucher(&ctx, 5, 10_000_000);

    let res = report_conflict(&mut ctx, &a, &b, &device, &device);
    assert!(res.is_err());
    assert!(res.unwrap_err().contains("NotSameSequence"));
    assert_eq!(vault_state(&ctx).status, 0);
}

/// Anyone may report, but only against real signatures. Otherwise freezing a
/// competitor's vault costs nothing but two made-up vouchers.
#[test]
fn conflict_proof_rejects_forged_signatures() {
    let mut ctx = setup();
    let device = ctx.device.clone();
    let attacker = device_key(99);

    let a = voucher(&ctx, 4, 10_000_000);
    let mut b = voucher(&ctx, 4, 20_000_000);
    b.salt = [2u8; 8];

    let res = report_conflict(&mut ctx, &a, &b, &device, &attacker);
    assert!(res.is_err(), "a voucher the device never signed proves nothing");
    assert!(res.unwrap_err().contains("DeviceKeyMismatch"));
    assert_eq!(vault_state(&ctx).status, 0, "no freeze on a forged proof");
}

/// The freeze blocks the payer's exit.
#[test]
fn frozen_vault_blocks_withdraw() {
    let mut ctx = setup();
    let device = ctx.device.clone();
    let owner = ctx.owner.insecure_clone();

    let request = Instruction::new_with_bytes(
        nelo_vault::id(),
        &nelo_vault::instruction::RequestWithdraw {}.data(),
        nelo_vault::accounts::RequestWithdraw { owner: owner.pubkey(), vault: ctx.vault }
            .to_account_metas(None),
    );
    send(&mut ctx, &[request], &[&owner]).expect("request_withdraw");

    let a = voucher(&ctx, 4, 10_000_000);
    let mut b = voucher(&ctx, 4, 20_000_000);
    b.salt = [2u8; 8];
    report_conflict(&mut ctx, &a, &b, &device, &device).expect("freeze");

    assert_eq!(vault_state(&ctx).unlock_at, 0, "pending withdrawal was cancelled");

    warp(&mut ctx, 48 * 60 * 60);
    let withdraw = Instruction::new_with_bytes(
        nelo_vault::id(),
        &nelo_vault::instruction::Withdraw { amount: 1_000_000 }.data(),
        nelo_vault::accounts::Withdraw { owner: owner.pubkey(), vault: ctx.vault }
            .to_account_metas(None),
    );
    let res = send(&mut ctx, &[withdraw], &[&owner]);
    assert!(res.is_err(), "a frozen vault must not release collateral to its owner");
    assert!(res.unwrap_err().contains("VaultFrozen"));
}

/// ...but not the payees. A merchant holding a good voucher is a victim of the
/// fraud, not a party to it, and must still be able to claim.
#[test]
fn frozen_vault_still_pays_honest_merchants() {
    let mut ctx = setup();
    let device = ctx.device.clone();

    let a = voucher(&ctx, 4, 10_000_000);
    let mut b = voucher(&ctx, 4, 20_000_000);
    b.salt = [2u8; 8];
    report_conflict(&mut ctx, &a, &b, &device, &device).expect("freeze");
    assert_eq!(vault_state(&ctx).status, 1);

    let honest = voucher(&ctx, 9, 5_000_000);
    let before = ctx.svm.get_account(&ctx.merchant.pubkey()).unwrap().lamports;
    redeem(&mut ctx, &honest, &device)
        .expect("an unrelated merchant must still be paid from a frozen vault");
    let after = ctx.svm.get_account(&ctx.merchant.pubkey()).unwrap().lamports;
    assert_eq!(after - before, 5_000_000);
}

/// Only one of the two conflicting vouchers can ever settle, frozen or not —
/// the replay window is what actually caps the loss.
#[test]
fn only_one_side_of_a_conflict_can_settle() {
    let mut ctx = setup();
    let device = ctx.device.clone();

    let a = voucher(&ctx, 4, 10_000_000);
    let mut b = voucher(&ctx, 4, 20_000_000);
    b.salt = [2u8; 8];

    redeem(&mut ctx, &a, &device).expect("first side settles");
    report_conflict(&mut ctx, &a, &b, &device, &device).expect("freeze");
    let res = redeem(&mut ctx, &b, &device);
    assert!(res.is_err(), "the other side of the conflict must never settle");
    assert!(res.unwrap_err().contains("SequenceAlreadyRedeemed"));
}

// ------------------------------------------------------------- toolchain guard ---

/// litesvm ships `precompiles` as a NON-default cargo feature. Without it the
/// secp256r1 program is simply absent and every signature test above dies with
/// `InvalidProgramForExecution` — which reads like a program bug, not a missing
/// feature flag. This test turns that regression into a legible failure.
#[test]
fn secp256r1_precompile_is_registered() {
    let svm = LiteSVM::new();
    let account = svm.get_account(&SECP256R1_ID);
    assert!(
        account.is_some_and(|a| a.executable),
        "secp256r1 precompile missing — re-enable litesvm's `precompiles` \
         feature in programs/nelo_vault/Cargo.toml"
    );
}

// ------------------------------------------------------------- low-S on chain ---

/// Force the upper-half S. Both S and n-S are valid ECDSA signatures over the
/// same message; the question is whether the chain accepts both.
fn sign_high_s(sk: &SigningKey, message: &[u8]) -> [u8; 64] {
    let low = sign(sk, message); // already normalised low
    // n - s, big-endian, on the low 32 bytes.
    const N: [u8; 32] = [
        0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84, 0xf3, 0xb9, 0xca, 0xc2, 0xfc, 0x63,
        0x25, 0x51,
    ];
    let mut out = low;
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let diff = N[i] as i16 - low[32 + i] as i16 - borrow;
        out[32 + i] = diff.rem_euclid(256) as u8;
        borrow = i16::from(diff < 0);
    }
    out
}

/// Android's KeyStore returns whatever S the hardware produced, and roughly
/// half of those are in the upper half of the order. If the chain refuses them,
/// every signing path has to normalise — so this pins down whether it does,
/// rather than leaving it as an assumption the Kotlin module might not honour.
#[test]
fn high_s_signature_does_not_settle() {
    let mut ctx = setup();
    let device = ctx.device.clone();
    let v = voucher(&ctx, 0, 10_000_000);
    let msg = v.signed_message();

    let high = sign_high_s(&device, &msg);
    assert_ne!(high, sign(&device, &msg), "the two forms must differ");

    let ixs = [
        secp256r1_ix(&msg, &high, &device_pubkey(&device)),
        redeem_ix(&ctx, &v),
    ];
    let owner = ctx.owner.insecure_clone();
    let res = send(&mut ctx, &ixs, &[&owner]);

    assert!(
        res.is_err(),
        "high-S settled — every signing path must still normalise, but the \
         chain is not the thing enforcing it"
    );
    assert_eq!(vault_state(&ctx).balance, COLLATERAL, "nothing moved");
}
