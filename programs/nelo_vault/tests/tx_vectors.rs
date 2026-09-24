//! Golden vectors for the redemption transaction a merchant broadcasts.
//!
//! A voucher the program would accept is worth nothing if the phone assembles
//! the transaction wrongly: an account out of order, a discriminator off by a
//! byte, a precompile offset that points one field over. None of those show up
//! until a real sale fails to settle. So the TypeScript builder in
//! `packages/redeem` is not checked against a reading of this program — it is
//! checked against bytes this program's own generated code produces:
//!
//!   - instruction data from Anchor's `instruction::RedeemVoucher`,
//!   - the account list from Anchor's `accounts::RedeemVoucher`,
//!   - token accounts from `anchor_spl`'s ATA derivation,
//!   - precompile data from the crate's `precompile_instruction_data`, which
//!     the LiteSVM suite in `tests/vault.rs` submits to the real precompile.
//!
//! Host-only: no validator, no built .so. Regenerate with
//!
//!   cargo test -p nelo_vault --test tx_vectors -- --ignored --nocapture emit
//!
//! and write the output to packages/redeem/vectors/redeem-v1.json.

use {
    anchor_lang::{
        prelude::Pubkey, solana_program::instruction::AccountMeta, InstructionData, ToAccountMetas,
    },
    anchor_spl::associated_token::get_associated_token_address_with_program_id,
    nelo_vault::voucher::{precompile_instruction_data, VoucherArgs},
    p256::ecdsa::{signature::Signer as _, Signature, SigningKey},
    serde_json::{json, Value},
};

const VECTORS: &str = include_str!("../../../packages/redeem/vectors/redeem-v1.json");

const SPL_TOKEN: Pubkey = solana_pubkey::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022: Pubkey = solana_pubkey::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA_PROGRAM: Pubkey = solana_pubkey::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM_PROGRAM: Pubkey = solana_pubkey::pubkey!("11111111111111111111111111111111");
const INSTRUCTIONS_SYSVAR: Pubkey =
    solana_pubkey::pubkey!("Sysvar1nstructions1111111111111111111111111");
const SECP256R1_PROGRAM: Pubkey =
    solana_pubkey::pubkey!("Secp256r1SigVerify1111111111111111111111111");
/// Circle's devnet USDC — the mint the merchant app takes today.
const DEVNET_USDC: Pubkey = solana_pubkey::pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Same key as `tests/vectors.rs`, so the two vector files agree on a device.
fn device_key() -> SigningKey {
    let mut bytes = [1u8; 32];
    bytes[31] = 7;
    SigningKey::from_slice(&bytes).unwrap()
}

fn sign_low_s(sk: &SigningKey, message: &[u8]) -> [u8; 64] {
    let sig: Signature = sk.sign(message);
    let sig = sig.normalize_s().unwrap_or(sig);
    let mut out = [0u8; 64];
    out.copy_from_slice(&sig.to_bytes());
    out
}

fn vault_of(owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"vault", owner.as_ref()], &nelo_vault::id()).0
}

struct Case {
    name: &'static str,
    voucher: VoucherArgs,
    payer: Pubkey,
    mint: Pubkey,
    token_program: Pubkey,
}

/// Each case earns its place by breaking a different wrong builder.
fn cases() -> Vec<Case> {
    let merchant = Pubkey::new_from_array([0x22; 32]);
    let relayer = Pubkey::new_from_array([0x33; 32]);
    vec![
        // The ordinary sale: the merchant broadcasts on reconnect and pays the
        // fee, so the payer and the merchant are the same key. The account list
        // must still carry it twice, in both positions.
        Case {
            name: "merchant_broadcasts",
            voucher: VoucherArgs {
                version: 1,
                vault: vault_of(&Pubkey::new_from_array([0x44; 32])),
                seq: 42,
                amount: 12_500_000,
                remaining_after: 87_500_000,
                merchant,
                expires_at: 1_789_000_000,
                salt: [0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04],
            },
            payer: merchant,
            mint: DEVNET_USDC,
            token_program: SPL_TOKEN,
        },
        // A relayer pays; the mint lives under Token-2022, which moves every
        // token account address. A builder that hard-codes SPL Token derives
        // the wrong ATAs here and nowhere else.
        Case {
            name: "relayer_token_2022",
            voucher: VoucherArgs {
                version: 1,
                vault: vault_of(&Pubkey::new_from_array([0x55; 32])),
                seq: u64::MAX,
                amount: u64::MAX,
                remaining_after: 0,
                merchant: Pubkey::new_from_array([0x66; 32]),
                expires_at: -1,
                salt: [0xff; 8],
            },
            payer: relayer,
            mint: Pubkey::new_from_array([0x77; 32]),
            token_program: TOKEN_2022,
        },
    ]
}

fn account_json(meta: &AccountMeta) -> Value {
    json!({
        "pubkey": meta.pubkey.to_string(),
        "isSigner": meta.is_signer,
        "isWritable": meta.is_writable,
    })
}

/// Everything the builder must reproduce, computed only from the program's own
/// code and the libraries it links.
fn expected(case: &Case) -> Value {
    let sk = device_key();
    let pubkey: [u8; 33] = sk
        .verifying_key()
        .to_encoded_point(true)
        .as_bytes()
        .try_into()
        .unwrap();
    let message = case.voucher.signed_message();
    let signature = sign_low_s(&sk, &message);

    let config = Pubkey::find_program_address(&[b"risk"], &nelo_vault::id()).0;
    let accounts = nelo_vault::accounts::RedeemVoucher {
        payer: case.payer,
        vault: case.voucher.vault,
        config,
        mint: case.mint,
        merchant: case.voucher.merchant,
        merchant_token: get_associated_token_address_with_program_id(
            &case.voucher.merchant,
            &case.mint,
            &case.token_program,
        ),
        vault_token: get_associated_token_address_with_program_id(
            &case.voucher.vault,
            &case.mint,
            &case.token_program,
        ),
        instructions: INSTRUCTIONS_SYSVAR,
        token_program: case.token_program,
        associated_token_program: ATA_PROGRAM,
        system_program: SYSTEM_PROGRAM,
    }
    .to_account_metas(None);
    let data = nelo_vault::instruction::RedeemVoucher {
        voucher: case.voucher.clone(),
    }
    .data();

    let mut packet = message.to_vec();
    packet.extend_from_slice(&signature);
    packet.extend_from_slice(&pubkey);

    json!({
        "name": case.name,
        "input": {
            "packetHex": hex(&packet),
            "payer": case.payer.to_string(),
            "mint": case.mint.to_string(),
            "tokenProgram": case.token_program.to_string(),
        },
        "precompile": {
            "programId": SECP256R1_PROGRAM.to_string(),
            "dataHex": hex(&precompile_instruction_data(&message, &signature, &pubkey)),
        },
        "redeem": {
            "programId": nelo_vault::id().to_string(),
            "dataHex": hex(&data),
            "accounts": accounts.iter().map(account_json).collect::<Vec<_>>(),
        },
    })
}

/// Encodings with the runtime's own on-curve verdict — `is_on_curve` is
/// curve25519-dalek's `decompress`, the check that decides which PDA bump is
/// canonical. The awkward ones are here on purpose: non-canonical y, the sign
/// bit set on a point whose x is zero. Strict RFC 8032 decoders disagree with
/// dalek on exactly these, and the phone must agree with the runtime.
fn curve_cases() -> Vec<[u8; 32]> {
    let mut out = Vec::new();
    let with_y = |low: &[u8], top: u8| {
        let mut b = [0u8; 32];
        b[..low.len()].copy_from_slice(low);
        b[31] |= top;
        b
    };
    // p = 2^255 - 19, little-endian.
    let mut p = [0xffu8; 32];
    p[0] = 0xed;
    p[31] = 0x7f;
    let mut p_plus_1 = p;
    p_plus_1[0] = 0xee;
    let mut p_minus_1 = p;
    p_minus_1[0] = 0xec;

    out.push([0u8; 32]); // y = 0
    out.push(with_y(&[1], 0)); // the identity
    out.push(with_y(&[1], 0x80)); // the identity, sign bit set: x = 0
    out.push(p_minus_1); // y = -1, the point of order two
    out.push({
        let mut b = p_minus_1;
        b[31] |= 0x80;
        b
    }); // y = -1 with the sign bit: x = 0 again
    out.push(p); // non-canonical y = 0
    out.push(p_plus_1); // non-canonical identity
    out.push([0xffu8; 32]); // y = 2^255 - 1 masked, non-canonical
    for y in 2u8..8 {
        out.push(with_y(&[y], 0));
    }
    // The ed25519 base point.
    let mut base = [0x66u8; 32];
    base[0] = 0x58;
    out.push(base);

    // And a spread of arbitrary ones, deterministic so the file is stable.
    let mut state: u64 = 0x9e37_79b9_7f4a_7c15;
    for _ in 0..48 {
        let mut b = [0u8; 32];
        for chunk in b.chunks_mut(8) {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            chunk.copy_from_slice(&state.to_le_bytes());
        }
        out.push(b);
    }
    out
}

fn all() -> Value {
    json!({
        "transactions": cases().iter().map(expected).collect::<Vec<_>>(),
        "curve": curve_cases()
            .iter()
            .map(|b| json!({ "hex": hex(b), "onCurve": Pubkey::new_from_array(*b).is_on_curve() }))
            .collect::<Vec<_>>(),
    })
}

#[test]
#[ignore = "generator, not a check — run with --ignored --nocapture"]
fn emit() {
    println!("{}", serde_json::to_string_pretty(&all()).unwrap());
}

#[test]
fn golden_vectors_match() {
    let stored: Value = serde_json::from_str(VECTORS).expect("redeem-v1.json is valid JSON");
    assert_eq!(
        stored,
        all(),
        "packages/redeem/vectors/redeem-v1.json no longer matches the program. \
         If the program changed on purpose, regenerate with the command at the top \
         of this file — and expect the TypeScript builder's tests to fail until it \
         is changed to match."
    );
}

/// The signed message is Borsh-identical to the instruction arguments, so the
/// instruction data is the discriminator followed by exactly the 105 bytes the
/// device signed. The TypeScript builder relies on that; pin it here, where a
/// change to `VoucherArgs` would break it.
#[test]
fn instruction_data_is_discriminator_then_signed_message() {
    for case in cases() {
        let data = nelo_vault::instruction::RedeemVoucher {
            voucher: case.voucher.clone(),
        }
        .data();
        assert_eq!(data.len(), 8 + 105, "{}", case.name);
        assert_eq!(&data[8..], &case.voucher.signed_message(), "{}", case.name);
    }
}
