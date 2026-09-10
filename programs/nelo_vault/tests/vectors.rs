//! Cross-language golden vectors for the voucher wire format.
//!
//! Bytes 0..105 are the contract between the phone and the chain: whatever the
//! TypeScript emitter produces, `VoucherArgs::signed_message()` must rebuild
//! byte for byte, or every signature fails on chain for reasons that look like
//! a crypto bug and are actually a layout drift.
//!
//! The chain is authoritative, so these vectors are generated here and asserted
//! on both sides. Regenerate with:
//!
//!   cargo test -p nelo_vault --test vectors -- --ignored --nocapture emit
//!
//! and paste the output into packages/voucher/vectors/voucher-v1.json.

use {
    anchor_lang::prelude::Pubkey,
    nelo_vault::voucher::VoucherArgs,
    p256::ecdsa::{signature::Signer as _, Signature, SigningKey},
};

const VECTORS: &str = include_str!("../../../packages/voucher/vectors/voucher-v1.json");

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

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

/// The cases. Deliberately includes the boundaries, because a u64 that is
/// written big-endian by mistake still round-trips inside one language.
fn cases() -> Vec<(&'static str, VoucherArgs)> {
    vec![
        (
            "zeros",
            VoucherArgs {
                version: 1,
                vault: Pubkey::new_from_array([0u8; 32]),
                seq: 0,
                amount: 0,
                remaining_after: 0,
                merchant: Pubkey::new_from_array([0u8; 32]),
                expires_at: 0,
                salt: [0u8; 8],
            },
        ),
        (
            "typical",
            VoucherArgs {
                version: 1,
                vault: Pubkey::new_from_array([0x11; 32]),
                seq: 42,
                amount: 12_500_000, // 12.50 USDC at 6dp
                remaining_after: 87_500_000,
                merchant: Pubkey::new_from_array([0x22; 32]),
                expires_at: 1_789_000_000,
                salt: [0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04],
            },
        ),
        (
            "max_values",
            VoucherArgs {
                version: 1,
                vault: Pubkey::new_from_array([0xff; 32]),
                seq: u64::MAX,
                amount: u64::MAX,
                remaining_after: u64::MAX,
                merchant: Pubkey::new_from_array([0xfe; 32]),
                expires_at: i64::MAX,
                salt: [0xff; 8],
            },
        ),
        (
            "negative_expiry",
            VoucherArgs {
                version: 1,
                vault: Pubkey::new_from_array([0x01; 32]),
                seq: 1,
                amount: 1,
                remaining_after: 0,
                merchant: Pubkey::new_from_array([0x02; 32]),
                expires_at: -1, // i64, not u64 — catches an unsigned read
                salt: [0u8; 8],
            },
        ),
    ]
}

#[test]
#[ignore = "generator, not a check — run with --ignored --nocapture"]
fn emit() {
    let sk = device_key();
    let pk = sk.verifying_key().to_encoded_point(true);
    let mut out = String::from("[\n");
    for (i, (name, v)) in cases().iter().enumerate() {
        let msg = v.signed_message();
        let sig = sign_low_s(&sk, &msg);
        let mut packet = msg.to_vec();
        packet.extend_from_slice(&sig);
        packet.extend_from_slice(pk.as_bytes());
        out.push_str(&format!(
            "  {{\n    \"name\": \"{}\",\n    \"fields\": {{\n      \"version\": {},\n      \"vault\": \"{}\",\n      \"seq\": \"{}\",\n      \"amount\": \"{}\",\n      \"remainingAfter\": \"{}\",\n      \"merchant\": \"{}\",\n      \"expiresAt\": \"{}\",\n      \"salt\": \"{}\"\n    }},\n    \"signature\": \"{}\",\n    \"devicePubkey\": \"{}\",\n    \"signedHex\": \"{}\",\n    \"packetHex\": \"{}\"\n  }}{}\n",
            name,
            v.version,
            hex(v.vault.as_ref()),
            v.seq,
            v.amount,
            v.remaining_after,
            hex(v.merchant.as_ref()),
            v.expires_at,
            hex(&v.salt),
            hex(&sig),
            hex(pk.as_bytes()),
            hex(&msg),
            hex(&packet),
            if i + 1 == cases().len() { "" } else { "," }
        ));
    }
    out.push_str("]\n");
    println!("{out}");
}

/// The actual check: every frozen vector must still rebuild from the fields.
#[test]
fn golden_vectors_match() {
    let parsed: serde_json::Value = serde_json::from_str(VECTORS).expect("vectors parse");
    let arr = parsed.as_array().expect("vectors is an array");
    assert!(!arr.is_empty(), "vectors file is empty");

    for case in arr {
        let name = case["name"].as_str().unwrap();
        let f = &case["fields"];
        let v = VoucherArgs {
            version: f["version"].as_u64().unwrap() as u8,
            vault: Pubkey::new_from_array(unhex(f["vault"].as_str().unwrap()).try_into().unwrap()),
            seq: f["seq"].as_str().unwrap().parse().unwrap(),
            amount: f["amount"].as_str().unwrap().parse().unwrap(),
            remaining_after: f["remainingAfter"].as_str().unwrap().parse().unwrap(),
            merchant: Pubkey::new_from_array(
                unhex(f["merchant"].as_str().unwrap()).try_into().unwrap(),
            ),
            expires_at: f["expiresAt"].as_str().unwrap().parse().unwrap(),
            salt: unhex(f["salt"].as_str().unwrap()).try_into().unwrap(),
        };

        assert_eq!(
            hex(&v.signed_message()),
            case["signedHex"].as_str().unwrap(),
            "signed message drifted for vector '{name}' — the phone and the chain \
             no longer agree on the wire format"
        );
        assert_eq!(v.signed_message().len(), 105, "vector '{name}' wrong length");
    }
}
