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

/// Instruction data for the secp256r1 precompile, verifying one signature,
/// laid out exactly as [`assert_precompile_verified`] reads it back.
///
/// The writer sits beside the reader on purpose. The layout is a contract
/// between three parties — this program, the native precompile, and whatever
/// assembles the transaction on a phone or a relay — and the only way to keep
/// three copies of one byte layout from drifting is to have one copy. Every
/// other builder, including the TypeScript one in `packages/redeem`, is checked
/// byte for byte against this through `tests/tx_vectors.rs`.
///
/// Layout, all integers little-endian:
///
/// ```text
///   0      count           = 1
///   1      padding         = 0
///   2..16  seven u16s      signature offset, its ix index,
///                          public key offset, its ix index,
///                          message offset, message length, its ix index
///   16..   public key (33) ‖ signature (64) ‖ message
/// ```
///
/// Every instruction index is `u16::MAX`, the precompile's "this instruction"
/// sentinel. [`assert_precompile_verified`] refuses anything else, because an
/// index pointing at another instruction lets an attacker have the precompile
/// verify one set of bytes while the program reads a different set.
///
/// Never called on chain — no instruction invokes it — so the panic on an
/// oversized message only ever fires in off-chain or test code, where a
/// silently truncated length would be far worse than a loud one.
pub fn precompile_instruction_data(
    message: &[u8],
    signature: &[u8; SIGNATURE_SERIALIZED_SIZE],
    pubkey: &[u8; COMPRESSED_PUBKEY_SERIALIZED_SIZE],
) -> Vec<u8> {
    let message_len =
        u16::try_from(message.len()).expect("a secp256r1 message length must fit in a u16");
    let pubkey_offset = PRECOMPILE_DATA_START as u16;
    let signature_offset = pubkey_offset + COMPRESSED_PUBKEY_SERIALIZED_SIZE as u16;
    let message_offset = signature_offset + SIGNATURE_SERIALIZED_SIZE as u16;

    let mut data = Vec::with_capacity(message_offset as usize + message.len());
    data.push(1); // exactly one signature
    data.push(0); // padding
    data.extend_from_slice(&signature_offset.to_le_bytes());
    data.extend_from_slice(&u16::MAX.to_le_bytes());
    data.extend_from_slice(&pubkey_offset.to_le_bytes());
    data.extend_from_slice(&u16::MAX.to_le_bytes());
    data.extend_from_slice(&message_offset.to_le_bytes());
    data.extend_from_slice(&message_len.to_le_bytes());
    data.extend_from_slice(&u16::MAX.to_le_bytes());
    data.extend_from_slice(pubkey);
    data.extend_from_slice(signature);
    data.extend_from_slice(message);
    data
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

#[cfg(test)]
mod precompile_layout {
    //! The writer's output, decoded by hand against the constants the reader
    //! uses. Runs in the fast host job, with no validator, so a layout slip is
    //! caught in seconds rather than after a toolchain install.

    use super::*;

    fn u16_at(data: &[u8], at: usize) -> u16 {
        u16::from_le_bytes([data[at], data[at + 1]])
    }

    #[test]
    fn every_field_lands_where_the_header_says() {
        let message = [0xabu8; SIGNED_LEN];
        let signature = [0xcdu8; SIGNATURE_SERIALIZED_SIZE];
        let pubkey = [0xefu8; COMPRESSED_PUBKEY_SERIALIZED_SIZE];
        let data = precompile_instruction_data(&message, &signature, &pubkey);

        assert_eq!(data[0], 1, "exactly one signature");
        let o = SIG_OFFSETS_START;
        let (sig_off, pk_off, msg_off) = (
            u16_at(&data, o) as usize,
            u16_at(&data, o + 4) as usize,
            u16_at(&data, o + 8) as usize,
        );
        let msg_len = u16_at(&data, o + 10) as usize;

        assert_eq!(&data[pk_off..pk_off + 33], &pubkey);
        assert_eq!(&data[sig_off..sig_off + 64], &signature);
        assert_eq!(msg_len, SIGNED_LEN);
        assert_eq!(&data[msg_off..msg_off + msg_len], &message);
        assert_eq!(data.len(), msg_off + msg_len, "no trailing bytes");
    }

    /// The property the reader's security rests on. If any index is not the
    /// sentinel, the precompile can be pointed at bytes the program never reads.
    #[test]
    fn every_instruction_index_is_the_self_sentinel() {
        let data = precompile_instruction_data(
            &[0u8; SIGNED_LEN],
            &[0u8; SIGNATURE_SERIALIZED_SIZE],
            &[0u8; COMPRESSED_PUBKEY_SERIALIZED_SIZE],
        );
        let o = SIG_OFFSETS_START;
        assert_eq!(u16_at(&data, o + 2), u16::MAX, "signature ix index");
        assert_eq!(u16_at(&data, o + 6), u16::MAX, "public key ix index");
        assert_eq!(u16_at(&data, o + 12), u16::MAX, "message ix index");
    }
}
