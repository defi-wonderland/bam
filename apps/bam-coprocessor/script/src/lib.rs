//! Shared utilities for bam-coprocessor host scripts.

use serde::{Deserialize, Serialize};

const BATCH_STRIDE: usize = 32 + 48 + 32 + 8 + 4; // 124 bytes

// ── Circuit 1 public values ───────────────────────────────────────────────────

/// Decoded Circuit 1 public output.
#[derive(Debug, Serialize, Deserialize)]
pub struct PublicValues {
    pub chain_id: u64,
    /// sha256 of the canonical sorted message stream.
    pub message_commitment: String,
    pub batch_count: usize,
    pub batches: Vec<BatchMeta>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BatchMeta {
    pub versioned_hash: String,
    pub commitment: String,
    pub content_tag: String,
    pub block_number: u64,
    pub tx_index: u32,
}

/// Parse the raw public-output bytes committed by the circuit.
pub fn parse_public_values(raw: &[u8]) -> PublicValues {
    let chain_id = u64::from_le_bytes(raw[0..8].try_into().unwrap());
    let m: [u8; 32] = raw[8..40].try_into().unwrap();
    let batch_count = u32::from_le_bytes(raw[40..44].try_into().unwrap()) as usize;

    let batches = (0..batch_count)
        .map(|i| {
            let off = 44 + i * BATCH_STRIDE;
            let vh: [u8; 32] = raw[off..off + 32].try_into().unwrap();
            let c: [u8; 48] = raw[off + 32..off + 80].try_into().unwrap();
            let ct: [u8; 32] = raw[off + 80..off + 112].try_into().unwrap();
            let bn = u64::from_le_bytes(raw[off + 112..off + 120].try_into().unwrap());
            let ti = u32::from_le_bytes(raw[off + 120..off + 124].try_into().unwrap());
            BatchMeta {
                versioned_hash: format!("0x{}", hex::encode(vh)),
                commitment: format!("0x{}", hex::encode(c)),
                content_tag: format!("0x{}", hex::encode(ct)),
                block_number: bn,
                tx_index: ti,
            }
        })
        .collect();

    PublicValues {
        chain_id,
        message_commitment: format!("0x{}", hex::encode(m)),
        batch_count,
        batches,
    }
}

/// Print Circuit 1 public values in a human-readable format.
pub fn print_public_values(pv: &PublicValues) {
    println!("chain_id:             {}", pv.chain_id);
    println!("message commitment M: {}", pv.message_commitment);
    println!("batches processed:    {}", pv.batch_count);
    for (i, b) in pv.batches.iter().enumerate() {
        println!(
            "  batch[{}] block={} tx={} vh={}…  ct={}…  C={}…",
            i,
            b.block_number,
            b.tx_index,
            &b.versioned_hash[..12],
            &b.content_tag[..12],
            &b.commitment[..12],
        );
    }
}

// ── Circuit 2 public values ───────────────────────────────────────────────────

/// Decoded Circuit 2 public output.
#[derive(Debug, Serialize, Deserialize)]
pub struct AppPublicValues {
    pub chain_id: u64,
    /// M — Circuit 1 message commitment (integrity anchor).
    pub message_commitment: String,
    /// R — sha256 of the canonical deduplicated bam-twitter timeline.
    pub timeline_root: String,
    pub tweet_count: u32,
}

/// Parse the raw public-output bytes committed by Circuit 2.
pub fn parse_app_public_values(raw: &[u8]) -> AppPublicValues {
    let chain_id = u64::from_le_bytes(raw[0..8].try_into().unwrap());
    let m: [u8; 32] = raw[8..40].try_into().unwrap();
    let r: [u8; 32] = raw[40..72].try_into().unwrap();
    let tweet_count = u32::from_le_bytes(raw[72..76].try_into().unwrap());
    AppPublicValues {
        chain_id,
        message_commitment: format!("0x{}", hex::encode(m)),
        timeline_root: format!("0x{}", hex::encode(r)),
        tweet_count,
    }
}

/// Print Circuit 2 public values in a human-readable format.
pub fn print_app_public_values(pv: &AppPublicValues) {
    println!("chain_id:             {}", pv.chain_id);
    println!("message commitment M: {}", pv.message_commitment);
    println!("timeline root R:      {}", pv.timeline_root);
    println!("tweets:               {}", pv.tweet_count);
}
