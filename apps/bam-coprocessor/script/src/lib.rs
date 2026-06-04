//! Shared utilities for bam-coprocessor host scripts.

pub mod blob_fetch;
pub mod kzg;
pub mod pipeline;
pub mod reader_api;
pub mod sp1_runner;

use serde::{Deserialize, Serialize};

// ── Circuit 1 public values ───────────────────────────────────────────────────

/// Decoded Circuit 1 public output (152 bytes, fixed).
#[derive(Debug, Serialize, Deserialize)]
pub struct MessagePublicValues {
    pub chain_id: u64,
    pub versioned_hash: String,
    pub content_tag: String,
    pub start_fe: u16,
    pub end_fe: u16,
    pub block_number: u64,
    pub tx_index: u32,
    pub msg_index: u32,
    pub sender: String,
    pub nonce: u64,
    pub message_hash: String,
}

/// Parse the raw 152-byte Circuit 1 public output. Errors on length
/// mismatch; once length holds, every fixed-offset slice is infallible.
pub fn parse_message_public_values(raw: &[u8]) -> anyhow::Result<MessagePublicValues> {
    if raw.len() != 152 {
        anyhow::bail!("expected 152-byte public output, got {}", raw.len());
    }
    let chain_id     = u64::from_le_bytes(raw[0..8].try_into().unwrap());
    let vh: [u8; 32] = raw[8..40].try_into().unwrap();
    let ct: [u8; 32] = raw[40..72].try_into().unwrap();
    let start_fe     = u16::from_le_bytes(raw[72..74].try_into().unwrap());
    let end_fe       = u16::from_le_bytes(raw[74..76].try_into().unwrap());
    let block_number = u64::from_le_bytes(raw[76..84].try_into().unwrap());
    let tx_index     = u32::from_le_bytes(raw[84..88].try_into().unwrap());
    let msg_index    = u32::from_le_bytes(raw[88..92].try_into().unwrap());
    let sender: [u8; 20] = raw[92..112].try_into().unwrap();
    let nonce        = u64::from_le_bytes(raw[112..120].try_into().unwrap());
    let mh: [u8; 32] = raw[120..152].try_into().unwrap();

    Ok(MessagePublicValues {
        chain_id,
        versioned_hash: format!("0x{}", hex::encode(vh)),
        content_tag:    format!("0x{}", hex::encode(ct)),
        start_fe,
        end_fe,
        block_number,
        tx_index,
        msg_index,
        sender:       format!("0x{}", hex::encode(sender)),
        nonce,
        message_hash: format!("0x{}", hex::encode(mh)),
    })
}

/// Derive the SP1 program VK hash (bytes32 hex) from a Groth16 proof's
/// `public_inputs[0]`. The gnark circuit stores `vk.bytes32()` as a
/// decimal BigUint string; converting back gives the value expected by
/// `Groth16Verifier::verify`.
pub fn vk_hash_from_groth16(decimal_str: &str) -> anyhow::Result<String> {
    use num_bigint::BigUint;
    use std::str::FromStr;
    let n = BigUint::from_str(decimal_str)
        .map_err(|e| anyhow::anyhow!("invalid groth16 public_inputs[0]: {}", e))?;
    Ok(format!("0x{:0>64}", n.to_str_radix(16)))
}

pub fn print_message_public_values(pv: &MessagePublicValues) {
    println!("chain_id:      {}", pv.chain_id);
    println!("block:         {}  tx: {}  msg: {}", pv.block_number, pv.tx_index, pv.msg_index);
    println!("sender:        {}", pv.sender);
    println!("nonce:         {}", pv.nonce);
    println!("content_tag:   {}", pv.content_tag);
    println!("segment:       fe[{}..{}]", pv.start_fe, pv.end_fe);
    println!("versioned_hash:{}", pv.versioned_hash);
    println!("message_hash:  {}", pv.message_hash);
}
