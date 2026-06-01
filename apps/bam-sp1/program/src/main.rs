//! BAM Twitter ZK guest program.
//!
//! This is the code that runs *inside* the SP1 zkVM.
//! SP1 generates a proof that this program was executed correctly.
//!
//! Execution flow:
//!   1. Read blob batches from the host (private witness)
//!   2. For each batch: sha256(blob_bytes), extract segment, decode messages + tweets
//!   3. Build timeline: sort by chain order, dedup by (sender, nonce)
//!   4. Compute timeline root R = sha256(ordered tweet records)
//!   5. Commit public values: blob_sha256s + R
//!
//! Public values layout (binary, committed via sp1_zkvm::io::commit_slice):
//!   [0..32]   timeline_root R
//!   [32..36]  blob count (u32 LE)
//!   [36..]    blob_sha256s, each 32 bytes — one per input batch
//!
//! On blob binding:
//!   blob_sha256s are computed INSIDE the circuit over the actual blob bytes
//!   the prover fed in. This binds the proof to specific byte content — a
//!   dishonest prover can't feed different bytes and claim R came from the
//!   real blobs. The off-chain verifier can then check:
//!     sha256(real_blob_from_blobscan) == blob_sha256s[i]
//!   Phase 4 replaces sha256 with KZG verification, which ties directly to
//!   the versioned hashes in the BlobBatchRegistered events on L1.

#![no_main]
sp1_zkvm::entrypoint!(main);

use bam_twitter_lib::{
    decode_batch, decode_twitter_contents, build_timeline, compute_timeline_root,
    extract_segment_bytes, BlobBatch, IndexedTweet,
};
use sha2::{Digest, Sha256};

/// keccak256("bam-twitter.v1") — only messages with this contentTag are twitter posts.
const TWITTER_TAG: [u8; 32] = [
    0xf0, 0xfe, 0xa9, 0x4f, 0xfd, 0x2a, 0xe3, 0x2e,
    0xd8, 0x78, 0xc5, 0x7e, 0x34, 0x27, 0xbb, 0xff,
    0xab, 0x46, 0xd3, 0x33, 0xd0, 0x98, 0x37, 0xbc,
    0x64, 0x0d, 0x95, 0x27, 0x95, 0x09, 0x07, 0x18,
];

pub fn main() {
    // ── Step 1: read private inputs from host ────────────────────────────────
    let batches: Vec<BlobBatch> = sp1_zkvm::io::read::<Vec<BlobBatch>>();

    // ── Step 2: process each blob batch ──────────────────────────────────────
    let mut blob_sha256s: Vec<[u8; 32]> = Vec::with_capacity(batches.len());
    let mut all_tweets: Vec<IndexedTweet> = Vec::new();

    for batch in &batches {
        // 2a. Hash the full blob bytes inside the circuit.
        //     This commits the proof to the exact bytes the prover fed in.
        //     Phase 4: replace with KZG opening verification against versioned_hash.
        let blob_hash: [u8; 32] = Sha256::digest(&batch.blob_bytes).into();
        blob_sha256s.push(blob_hash);

        // 2b. Extract the twitter segment: strip 0x00 padding from each field element.
        let segment = extract_segment_bytes(&batch.blob_bytes, batch.start_fe, batch.end_fe);

        // 2c. Decode the BAM batch wire format into individual messages.
        let messages = decode_batch(&segment);

        // 2d. Filter to TWITTER_TAG, decode the app-layer envelope.
        for (msg_index, msg) in messages.into_iter().enumerate() {
            if msg.contents.len() < 32 || msg.contents[..32] != TWITTER_TAG {
                continue;
            }
            if let Some(tweet) = decode_twitter_contents(&msg.contents) {
                all_tweets.push(IndexedTweet {
                    sender: msg.sender,
                    nonce: msg.nonce,
                    block_number: batch.block_number,
                    tx_index: batch.tx_index,
                    msg_index: msg_index as u32,
                    tweet,
                });
            }
        }
    }

    // ── Step 3: sort by canonical chain order, dedup by (sender, nonce) ──────
    let timeline = build_timeline(all_tweets);

    // ── Step 4: compute timeline root R ──────────────────────────────────────
    let timeline_root = compute_timeline_root(&timeline);

    // ── Step 5: commit public values ─────────────────────────────────────────
    sp1_zkvm::io::commit_slice(&timeline_root);
    sp1_zkvm::io::commit_slice(&(blob_sha256s.len() as u32).to_le_bytes());
    for h in &blob_sha256s {
        sp1_zkvm::io::commit_slice(h);
    }
}
