//! Shared types and pipeline logic for the bam-twitter ZK indexer.
//!
//! This crate is compiled twice:
//!   - as a normal Rust lib for the host (script/)
//!   - as a no_std lib for the guest (program/) running inside the SP1 zkVM
//!
//! The pipeline mirrors apps/bam-indexer (TypeScript reference):
//!   blob bytes → extract_segment_bytes → decode_batch → decode_twitter_contents
//!   → sort by chain order → dedup by (sender, nonce) → sha256 → timeline root R

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

// ── Input types (private witness) ────────────────────────────────────────────

/// One blob batch: raw blob bytes + the chain metadata needed to locate the
/// twitter segment and order messages canonically.
///
/// Mirrors BlobBatch from bam-indexer/src/chain-fetcher.ts.
/// The host loads these from cache/batches.json and writes them to SP1Stdin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlobBatch {
    /// EIP-4844 versioned hash (keccak of the KZG commitment, 32 bytes).
    /// This is what appears in the BlobBatchRegistered event on L1.
    pub versioned_hash: [u8; 32],
    pub block_number: u64,
    pub tx_index: u32,
    pub log_index: u32,
    /// The twitter segment lives in field elements [start_fe, end_fe).
    pub start_fe: u16,
    pub end_fe: u16,
    /// Full 131072-byte blob (4096 field elements × 32 bytes).
    /// Byte 0 of each FE is always 0x00 (EIP-4844 KZG padding).
    pub blob_bytes: Vec<u8>,
}

/// Input for kzg-inside (KZG verification inside the zkVM).
///
/// Extends BlobBatch with a KZG commitment and opening proof so the guest can
/// verify the blob bytes are consistent with a committed polynomial before
/// running the indexing pipeline. This binds the timeline root R to the
/// commitment rather than to a sha256 of the prover-supplied bytes.
///
/// In the toy setup the commitment is C = f(τ)·G₁ where τ is a known scalar
/// and f is the polynomial whose coefficients are the blob field elements.
/// Production would use the real EIP-4844 trusted setup and evaluation-form
/// polynomials, with commitments verifiable against versioned_hashes on L1.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KZGBlobInput {
    pub versioned_hash: [u8; 32],
    pub block_number: u64,
    pub tx_index: u32,
    pub log_index: u32,
    pub start_fe: u16,
    pub end_fe: u16,
    /// Full 131072-byte blob. Byte 0 of each 32-byte field element is 0x00.
    pub blob_bytes: Vec<u8>,
    /// Compressed G1 point, exactly 48 bytes: C = f(τ)·G₁.
    pub commitment: Vec<u8>,
    /// Compressed G1 point, exactly 48 bytes: π = ((f(τ)−y)/(τ−z))·G₁.
    pub opening_proof: Vec<u8>,
}

// ── Intermediate types ────────────────────────────────────────────────────────

/// One decoded BAM message, before twitter-specific parsing.
#[derive(Debug, Clone)]
pub struct BamMessage {
    pub sender: [u8; 20],
    pub nonce: u64,
    /// Raw contents bytes: first 32 bytes = contentTag, rest = app payload.
    pub contents: Vec<u8>,
}

/// A decoded bam-twitter message, positioned in canonical chain order.
#[derive(Debug, Clone)]
pub struct IndexedTweet {
    pub sender: [u8; 20],
    pub nonce: u64,
    pub block_number: u64,
    pub tx_index: u32,
    pub msg_index: u32,
    pub tweet: TwitterMessage,
}

/// The app-layer content of a tweet.
///
/// Mirrors TwitterMessage from bam-indexer/src/twitter-codec.ts.
#[derive(Debug, Clone)]
pub enum TwitterMessage {
    Post { timestamp: u64, content: String },
    Reply { timestamp: u64, parent_message_hash: [u8; 32], content: String },
}

impl TwitterMessage {
    pub fn timestamp(&self) -> u64 {
        match self {
            TwitterMessage::Post { timestamp, .. } => *timestamp,
            TwitterMessage::Reply { timestamp, .. } => *timestamp,
        }
    }

    pub fn content(&self) -> &str {
        match self {
            TwitterMessage::Post { content, .. } => content,
            TwitterMessage::Reply { content, .. } => content,
        }
    }
}

// ── Output types (public values committed to in the proof) ────────────────────
// Phase 2 public values are committed as raw bytes by the guest (no struct):
//   [0..32]  timeline_root R
//   [32..36] blob count (u32 LE)
//   [36..]   blob_sha256s — sha256(blob_bytes) computed inside the circuit, one per blob
//
// Phase 4 will replace blob_sha256s with versioned_hashes + KZG opening proofs.
// A typed PublicValues struct will be introduced then.

// ── Pipeline ──────────────────────────────────────────────────────────────────

/// Strip the 0x00 padding byte (byte 0) from each field element in [start_fe, end_fe)
/// and concatenate the remaining 31 usable bytes per FE.
///
/// EIP-4844 blobs: 4096 FEs × 32 bytes = 131072 bytes total.
/// Byte 0 of each FE is forced to 0x00 by the KZG field constraint.
/// Usable bytes per FE: 31. Total usable per blob: 4096 × 31 = 126976 bytes.
///
/// TypeScript ref: packages/bam-sdk/src/blob/extract.ts
pub fn extract_segment_bytes(blob: &[u8], start_fe: u16, end_fe: u16) -> Vec<u8> {
    let mut result = Vec::with_capacity((end_fe - start_fe) as usize * 31);
    for fe in start_fe..end_fe {
        let offset = fe as usize * 32 + 1; // +1 to skip the 0x00 padding byte
        result.extend_from_slice(&blob[offset..offset + 31]);
    }
    result
}

/// Parse the BAM batch wire format from the extracted segment bytes.
///
/// Header (10 bytes, big-endian):
///   byte 0:      version  (must be 0x02)
///   byte 1:      codec    (0x00 = none | 0x01 = zstd; toy example only uses 0x00)
///   bytes 2..5:  message_count (uint32 BE)
///   bytes 6..9:  payload_len   (uint32 BE)
///
/// Per-message record:
///   20 bytes:  sender
///    8 bytes:  nonce (uint64 BE)
///    4 bytes:  contents_len (uint32 BE)
///    N bytes:  contents (first 32 = contentTag)
///   65 bytes:  signature (not verified here)
///
/// TypeScript ref: packages/bam-sdk/src/batch.ts
pub fn decode_batch(data: &[u8]) -> Vec<BamMessage> {
    if data.len() < 10 {
        return vec![];
    }
    if data[0] != 0x02 {
        return vec![];
    }
    if data[1] != 0x00 {
        // zstd not needed for toy example — all current blobs use codec=0x00
        return vec![];
    }

    let msg_count = u32::from_be_bytes([data[2], data[3], data[4], data[5]]) as usize;
    let payload_len = u32::from_be_bytes([data[6], data[7], data[8], data[9]]) as usize;

    if 10 + payload_len > data.len() {
        return vec![];
    }

    let payload = &data[10..10 + payload_len];
    let mut messages = Vec::with_capacity(msg_count);
    let mut o = 0;

    for _ in 0..msg_count {
        if o + 20 + 8 + 4 > payload.len() {
            break;
        }
        let sender: [u8; 20] = payload[o..o + 20].try_into().unwrap();
        o += 20;
        let nonce = u64::from_be_bytes(payload[o..o + 8].try_into().unwrap());
        o += 8;
        let contents_len = u32::from_be_bytes(payload[o..o + 4].try_into().unwrap()) as usize;
        o += 4;

        if o + contents_len + 65 > payload.len() {
            break;
        }
        let contents = payload[o..o + contents_len].to_vec();
        o += contents_len;
        // TODO: verify the ECDSA signature here before pushing the message.
        //
        // WHY: bam-reader's pipeline is decode → verify → store; it drops any
        // message whose signature doesn't recover to the claimed sender. This
        // circuit skips that step, so the timeline root R can include messages
        // that bam-reader would have silently dropped. R then does not describe
        // what users actually see, breaking the coprocessor's core guarantee.
        //
        // WHAT TO DO:
        //   1. Extract the 65 bytes here instead of skipping them.
        //   2. Compute the EIP-712 digest:
        //        domain  = { name: "BAM", version: "1", chainId }
        //        struct  = BAMMessage { sender: address, nonce: uint64, contents: bytes }
        //        digest  = hashTypedData(domain, struct)
        //      See packages/bam-sdk/src/signatures.ts:computeECDSADigest for the
        //      canonical TypeScript reference.
        //   3. Run secp256k1 ecrecover on the digest. SP1 has a secp256k1
        //      precompile (sp1_zkvm::precompiles::secp256k1), so this is cheap
        //      in-circuit.
        //   4. Only push the message if the recovered address == sender; skip it
        //      otherwise (same drop semantics as bam-reader's skippedVerify counter).
        //   5. Add chainId as a public input to the guest (currently absent). The
        //      EIP-712 domain is chain-bound, so without it the same signature is
        //      valid on every chain — making cross-chain replay trivially possible.
        //
        // SIGNATURE FORMAT: 65 bytes — r (32) | s (32) | v (1), v ∈ {27, 28}.
        // Canonical low-s is enforced by the SDK signer; the verifier should
        // reject high-s (sig.hasHighS() in the TS reference).
        o += 65;

        messages.push(BamMessage { sender, nonce, contents });
    }

    messages
}

/// Parse the twitter app envelope out of a message's contents bytes.
/// Returns None if the format is invalid (caller already filters by contentTag).
///
/// contents layout:
///   bytes  0..31:  contentTag (caller checks this = TWITTER_TAG)
///   byte  32:      envelope version (must be 0x01)
///   byte  33:      kind (0x00 = post, 0x01 = reply)
///
/// Post payload (from byte 34):
///   bytes  0.. 7:  timestamp (uint64 BE, Unix seconds)
///   bytes  8..11:  content_len (uint32 BE)
///   bytes 12..  :  UTF-8 content
///
/// Reply payload (from byte 34):
///   bytes  0.. 7:  timestamp
///   bytes  8..39:  parent_message_hash (bytes32)
///   bytes 40..43:  content_len
///   bytes 44..  :  UTF-8 content
///
/// TypeScript ref: bam-indexer/src/twitter-codec.ts
pub fn decode_twitter_contents(contents: &[u8]) -> Option<TwitterMessage> {
    if contents.len() < 34 {
        return None;
    }
    let app = &contents[32..]; // strip contentTag

    if app[0] != 0x01 {
        return None; // unsupported envelope version
    }

    let kind = app[1];

    match kind {
        0x00 => {
            // post
            if app.len() < 14 {
                return None;
            }
            let timestamp = u64::from_be_bytes(app[2..10].try_into().ok()?);
            let content_len = u32::from_be_bytes(app[10..14].try_into().ok()?) as usize;
            if 14 + content_len > app.len() {
                return None;
            }
            let content = String::from_utf8(app[14..14 + content_len].to_vec()).ok()?;
            Some(TwitterMessage::Post { timestamp, content })
        }
        0x01 => {
            // reply
            if app.len() < 46 {
                return None;
            }
            let timestamp = u64::from_be_bytes(app[2..10].try_into().ok()?);
            let parent_message_hash: [u8; 32] = app[10..42].try_into().ok()?;
            let content_len = u32::from_be_bytes(app[42..46].try_into().ok()?) as usize;
            if 46 + content_len > app.len() {
                return None;
            }
            let content = String::from_utf8(app[46..46 + content_len].to_vec()).ok()?;
            Some(TwitterMessage::Reply { timestamp, parent_message_hash, content })
        }
        _ => None,
    }
}

/// Sort messages into canonical chain order and deduplicate by (sender, nonce).
/// First occurrence of a (sender, nonce) pair wins — same rule as bam-store.
///
/// Sort key: (block_number ASC, tx_index ASC, msg_index ASC)
///
/// TypeScript ref: bam-indexer/src/pipeline.ts → buildTimelineFromBlobs
pub fn build_timeline(mut messages: Vec<IndexedTweet>) -> Vec<IndexedTweet> {
    messages.sort_by(|a, b| {
        a.block_number
            .cmp(&b.block_number)
            .then(a.tx_index.cmp(&b.tx_index))
            .then(a.msg_index.cmp(&b.msg_index))
    });

    let mut seen: HashSet<([u8; 20], u64)> = HashSet::new();
    messages
        .into_iter()
        .filter(|t| seen.insert((t.sender, t.nonce)))
        .collect()
}

/// Compute the timeline root R as sha256 over all tweets in canonical order.
///
/// Per-tweet record:
///   uint32 BE (record length) || sender (20) || nonce BE8 (8) || timestamp BE8 (8) || content (UTF-8)
///
/// R = sha256( frame(tweet_0) || frame(tweet_1) || ... )
///
/// TypeScript ref: bam-indexer/src/pipeline.ts → computeTimelineRoot
pub fn compute_timeline_root(timeline: &[IndexedTweet]) -> [u8; 32] {
    let mut hasher = Sha256::new();

    for tweet in timeline {
        let content = tweet.tweet.content().as_bytes();
        // record = sender(20) || nonce_be8(8) || timestamp_be8(8) || content
        let record_len = (20 + 8 + 8 + content.len()) as u32;

        hasher.update(record_len.to_be_bytes());  // uint32 BE length prefix
        hasher.update(tweet.sender);               // sender (20 bytes)
        hasher.update(tweet.nonce.to_be_bytes());  // nonce  (8 bytes BE)
        hasher.update(tweet.tweet.timestamp().to_be_bytes()); // timestamp (8 bytes BE)
        hasher.update(content);                    // UTF-8 content
    }

    hasher.finalize().into()
}
