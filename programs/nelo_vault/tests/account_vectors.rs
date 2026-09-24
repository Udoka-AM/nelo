//! Golden vectors for the two accounts a merchant caches to verify offline.
//!
//! The merchant's phone reads `Vault` and `RiskConfig` straight out of account
//! data and then decides, with no network, whether a voucher is good. If its
//! reading of the layout is one field off, it checks the voucher against the
//! wrong key or the wrong limit, and it does so silently. So the bytes are
//! produced here by Anchor's own serializer — discriminator included — and
//! `packages/enrol` must decode them to exactly these fields.
//!
//! Regenerate with
//!
//!   cargo test -p nelo_vault --test account_vectors -- --ignored --nocapture emit
//!
//! and write the output to packages/enrol/vectors/accounts-v1.json.

use {
    anchor_lang::{prelude::Pubkey, AccountSerialize, Discriminator, Space},
    nelo_vault::state::{RiskConfig, Vault},
    serde_json::{json, Value},
};

const VECTORS: &str = include_str!("../../../packages/enrol/vectors/accounts-v1.json");

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn bytes_of<T: AccountSerialize>(account: &T) -> Vec<u8> {
    let mut out = Vec::new();
    account.try_serialize(&mut out).unwrap();
    out
}

/// Every field distinct and every multi-byte field asymmetric, so a field read
/// from the wrong offset, or in the wrong byte order, cannot land on the right
/// value by accident.
fn vaults() -> Vec<(&'static str, Vault)> {
    let mut device = [0u8; 33];
    device[0] = 0x02;
    for (i, b) in device.iter_mut().enumerate().skip(1) {
        *b = i as u8;
    }
    vec![
        (
            "staked_and_active",
            Vault {
                owner: Pubkey::new_from_array([0x44; 32]),
                mint: Pubkey::new_from_array([0x55; 32]),
                device_pubkey: device,
                attestation_id: [0x09; 32],
                balance: 500_000_000,
                seq_base: 0x0102_0304_0506_0708,
                seq_bitmap: 0x8000_0000_0000_0000_0000_0000_0000_0005,
                floor_limit: 50_000_000,
                unlock_at: 1_789_000_123,
                stake: 100_000_000_000,
                reputation_bps: 12_345,
                pending_unstake: 40_000_000_000,
                unstake_unlock_at: -2,
                status: 0,
                bump: 254,
            },
        ),
        (
            "frozen_at_the_limits",
            Vault {
                owner: Pubkey::new_from_array([0xfe; 32]),
                mint: Pubkey::new_from_array([0xfd; 32]),
                device_pubkey: [0x03; 33],
                attestation_id: [0xff; 32],
                balance: u64::MAX,
                seq_base: u64::MAX,
                seq_bitmap: u128::MAX,
                floor_limit: u64::MAX,
                unlock_at: i64::MIN,
                stake: u64::MAX,
                reputation_bps: u16::MAX,
                pending_unstake: u64::MAX,
                unstake_unlock_at: i64::MAX,
                status: 1,
                bump: 1,
            },
        ),
    ]
}

fn risk_config() -> RiskConfig {
    RiskConfig {
        authority: Pubkey::new_from_array([0x66; 32]),
        stake_mint: Pubkey::new_from_array([0x77; 32]),
        k_bps: 0x0102_0304,
        stake_reference: 100_000_000,
        hard_cap: 200_000_000,
        stake_price: 2_000_000,
        haircut_bps: 5_000,
        unstake_cooldown: 86_400,
        bump: 253,
    }
}

fn vault_json(name: &str, v: &Vault) -> Value {
    json!({
        "name": name,
        "dataHex": hex(&bytes_of(v)),
        "fields": {
            "owner": v.owner.to_string(),
            "mint": v.mint.to_string(),
            "devicePubkey": hex(&v.device_pubkey),
            "attestationId": hex(&v.attestation_id),
            "balance": v.balance.to_string(),
            "seqBase": v.seq_base.to_string(),
            "seqBitmap": v.seq_bitmap.to_string(),
            "floorLimit": v.floor_limit.to_string(),
            "unlockAt": v.unlock_at.to_string(),
            "stake": v.stake.to_string(),
            "reputationBps": v.reputation_bps,
            "pendingUnstake": v.pending_unstake.to_string(),
            "unstakeUnlockAt": v.unstake_unlock_at.to_string(),
            "status": v.status,
            "bump": v.bump,
        },
    })
}

fn all() -> Value {
    let r = risk_config();
    json!({
        "vaultDiscriminatorHex": hex(Vault::DISCRIMINATOR),
        "riskConfigDiscriminatorHex": hex(RiskConfig::DISCRIMINATOR),
        "vaultSpace": 8 + Vault::INIT_SPACE,
        "riskConfigSpace": 8 + RiskConfig::INIT_SPACE,
        "vaults": vaults().iter().map(|(n, v)| vault_json(n, v)).collect::<Vec<_>>(),
        "riskConfig": {
            "dataHex": hex(&bytes_of(&r)),
            "fields": {
                "authority": r.authority.to_string(),
                "stakeMint": r.stake_mint.to_string(),
                "kBps": r.k_bps,
                "stakeReference": r.stake_reference.to_string(),
                "hardCap": r.hard_cap.to_string(),
                "stakePrice": r.stake_price.to_string(),
                "haircutBps": r.haircut_bps,
                "unstakeCooldown": r.unstake_cooldown.to_string(),
                "bump": r.bump,
            },
        },
    })
}

#[test]
#[ignore = "generator, not a check — run with --ignored --nocapture"]
fn emit() {
    println!("{}", serde_json::to_string_pretty(&all()).unwrap());
}

#[test]
fn golden_vectors_match() {
    let stored: Value = serde_json::from_str(VECTORS).expect("accounts-v1.json is valid JSON");
    assert_eq!(
        stored,
        all(),
        "packages/enrol/vectors/accounts-v1.json no longer matches the account layouts. \
         A changed layout also breaks every account already on chain; if that is \
         intended, regenerate with the command at the top of this file."
    );
}

/// The serialized length is the allocated length. A vault whose data is
/// shorter than the space allocated would decode with trailing zeros that the
/// phone must ignore, and this is where that assumption is pinned.
#[test]
fn serialized_length_is_the_allocated_space() {
    for (name, v) in vaults() {
        assert_eq!(bytes_of(&v).len(), 8 + Vault::INIT_SPACE, "{name}");
    }
    assert_eq!(bytes_of(&risk_config()).len(), 8 + RiskConfig::INIT_SPACE);
}
