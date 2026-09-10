use anchor_lang::prelude::*;
use solana_instructions_sysvar::load_instruction_at_checked;

use crate::{constants::*, error::NeloError, state::Vault};

/// The voucher fields the merchant submits on redemption. These are exactly the
/// fields the secure element signed — bytes 0..105 of the 202-byte wire format.
/// The signature and device key are not repeated here: they live in the
/// precompile instruction, which is where they are actually checked.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct VoucherArgs {
    pub version: u8,
    pub vault: Pubkey,
    pub seq: u64,
    pub amount: u64,
    /// Payer's claimed balance after this voucher. Carried so a merchant can
    /// sanity-check offline; deliberately *not* enforced on chain, because a
    /// payer may hold other vouchers that have not yet been redeemed.
    pub remaining_after: u64,
    pub merchant: Pubkey,
    pub expires_at: i64,
    pub salt: [u8; 8],
}

impl VoucherArgs {
    /// Rebuild the 105 bytes the device signed. Byte-for-byte identical to
    /// `packages/voucher` — if these two ever drift, the golden vectors fail.
    pub fn signed_message(&self) -> [u8; SIGNED_LEN] {
        let mut m = [0u8; SIGNED_LEN];
        m[0] = self.version;
        m[1..33].copy_from_slice(self.vault.as_ref());
        m[33..41].copy_from_slice(&self.seq.to_le_bytes());
        m[41..49].copy_from_slice(&self.amount.to_le_bytes());
        m[49..57].copy_from_slice(&self.remaining_after.to_le_bytes());
        m[57..89].copy_from_slice(self.merchant.as_ref());
        m[89..97].copy_from_slice(&self.expires_at.to_le_bytes());
        m[97..105].copy_from_slice(&self.salt);
        m
    }
}

/// Assert that the secp256r1 precompile — running as instruction 0 of this same
/// transaction — verified `expected_message` against `expected_pubkey`.
///
/// The precompile itself proves *a* signature was valid. It says nothing about
/// *which* key or *which* bytes. That is what this function pins down, and
/// getting it wrong is the failure mode where everything appears to work while
/// verifying nothing. The negative test is `rejects_signature_over_other_bytes`.
pub fn assert_precompile_verified(
    instructions_sysvar: &AccountInfo,
    ix_index: usize,
    expected_pubkey: &[u8; 33],
    expected_message: &[u8],
) -> Result<()> {
    let ix = load_instruction_at_checked(ix_index, instructions_sysvar)
        .map_err(|_| error!(NeloError::MissingPrecompileInstruction))?;

    require_keys_eq!(
        ix.program_id,
        SECP256R1_PROGRAM_ID,
        NeloError::MissingPrecompileInstruction
    );

    let data = &ix.data;
    require!(
        data.len() >= PRECOMPILE_DATA_START,
        NeloError::MalformedPrecompileInstruction
    );

    // Exactly one signature. More than one and "instruction 0 verified it"
    // stops being a statement about the signature we care about.
    require!(data[0] == 1, NeloError::ExpectedSingleSignature);

    let o = &data[SIG_OFFSETS_START..PRECOMPILE_DATA_START];
    let u16_at = |i: usize| -> u16 { u16::from_le_bytes([o[i], o[i + 1]]) };
    let signature_offset = u16_at(0) as usize;
    let signature_ix_index = u16_at(2);
    let public_key_offset = u16_at(4) as usize;
    let public_key_ix_index = u16_at(6);
    let message_offset = u16_at(8) as usize;
    let message_size = u16_at(10) as usize;
    let message_ix_index = u16_at(12);

    // Every field must live inside this instruction's own data (u16::MAX is the
    // precompile's "self" sentinel). Without this an attacker points the
    // precompile at bytes in a *different* instruction while we read ours, and
    // the checks below compare data that was never verified.
    require!(
        signature_ix_index == u16::MAX
            && public_key_ix_index == u16::MAX
            && message_ix_index == u16::MAX,
        NeloError::PrecompileDataNotSelfContained
    );

    let pk_end = public_key_offset
        .checked_add(COMPRESSED_PUBKEY_SERIALIZED_SIZE)
        .ok_or(NeloError::MalformedPrecompileInstruction)?;
    let sig_end = signature_offset
        .checked_add(SIGNATURE_SERIALIZED_SIZE)
        .ok_or(NeloError::MalformedPrecompileInstruction)?;
    let msg_end = message_offset
        .checked_add(message_size)
        .ok_or(NeloError::MalformedPrecompileInstruction)?;
    require!(
        pk_end <= data.len() && sig_end <= data.len() && msg_end <= data.len(),
        NeloError::MalformedPrecompileInstruction
    );

    require!(
        &data[public_key_offset..pk_end] == expected_pubkey.as_slice(),
        NeloError::DeviceKeyMismatch
    );
    require!(
        message_size == expected_message.len(),
        NeloError::SignedMessageMismatch
    );
    require!(
        &data[message_offset..msg_end] == expected_message,
        NeloError::SignedMessageMismatch
    );

    Ok(())
}

/// The 128-slot sliding window, as IPsec does anti-replay.
///
/// A single `last_seq` counter is the obvious design and it is wrong: if
/// merchant A holds voucher 5 and merchant B holds voucher 6 and B reconnects
/// first, A's voucher dies through no fault of A's. That is the common case at
/// a market, not an edge case.
pub fn consume_sequence(vault: &mut Vault, seq: u64) -> Result<()> {
    require!(seq >= vault.seq_base, NeloError::SequenceTooOld);

    let slot = seq
        .checked_sub(vault.seq_base)
        .ok_or(NeloError::SequenceTooOld)?;
    require!(slot < REPLAY_WINDOW, NeloError::SequenceTooFarAhead);

    let bit: u128 = 1u128 << slot;
    require!(
        vault.seq_bitmap & bit == 0,
        NeloError::SequenceAlreadyRedeemed
    );
    vault.seq_bitmap |= bit;

    // Advance the base past every contiguous redeemed slot at the bottom.
    while vault.seq_bitmap & 1 == 1 {
        vault.seq_bitmap >>= 1;
        vault.seq_base = vault.seq_base.checked_add(1).ok_or(NeloError::Overflow)?;
    }

    Ok(())
}
