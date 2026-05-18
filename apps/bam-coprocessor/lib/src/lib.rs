//! Shared types and pipeline logic for the BAM ZK coprocessor.
//!
//! Compiled twice: as a normal Rust lib for the host (script/) and as a
//! lib for each guest program running inside the SP1 zkVM.
//!
//! Circuit 1 pipeline (reader coprocessor):
//!   blob bytes → extract_segment_bytes → decode_batch → verify_ecdsa (per msg)
//!   → sort by chain order → compute_message_commitment M
//!
//! Circuit 2 pipeline (app coprocessor, bam-twitter):
//!   verify π₁ → assert M matches → filter TWITTER_TAG → decode_twitter_contents
//!   → build_timeline → compute_timeline_root R

use std::collections::HashSet;

use k256::ecdsa::{RecoveryId, Signature as K256Sig, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tiny_keccak::{Hasher, Keccak};

// ── Input types ───────────────────────────────────────────────────────────────

/// All inputs the host must supply for one blob batch (Circuit 1 private inputs).
///
/// Metadata fields (versioned_hash, commitment, content_tag, decoder,
/// sig_registry, block_number, tx_index) are committed as public outputs so
/// the verifier can cross-check them against L1 events.
///
/// decoder and sig_registry are asserted == 0x0 inside the circuit; batches
/// that use on-chain contracts are outside the circuit's scope.
///
/// start_fe / end_fe come from the BlobSegmentDeclared event joined to
/// BlobBatchRegistered by (txHash, contentTag) on the host side.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReaderBatch {
    pub versioned_hash: [u8; 32],
    /// KZG commitment C = f(τ)·G₁, compressed G1 point (48 bytes).
    pub commitment: Vec<u8>,
    /// KZG opening proof π, compressed G1 point (48 bytes).
    pub opening_proof: Vec<u8>,
    pub content_tag: [u8; 32],
    pub decoder: [u8; 20],
    pub sig_registry: [u8; 20],
    pub block_number: u64,
    pub tx_index: u32,
    /// From BlobSegmentDeclared, joined by host.
    pub start_fe: u16,
    pub end_fe: u16,
    /// Full 131072-byte EIP-4844 blob (4096 × 32 bytes).
    pub blob_bytes: Vec<u8>,
}

/// One decoded BAM message before app-layer parsing, carrying its raw signature.
#[derive(Debug, Clone)]
pub struct BamMessage {
    pub sender: [u8; 20],
    pub nonce: u64,
    /// Raw contents bytes: first 32 bytes = contentTag, rest = app payload.
    pub contents: Vec<u8>,
}

/// A verified BAM message — sender's ECDSA signature checked — plus chain
/// position. This is Circuit 1's unit of output and Circuit 2's unit of input.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifiedMessage {
    pub sender: [u8; 20],
    pub nonce: u64,
    /// Full contents including 32-byte contentTag prefix.
    pub contents: Vec<u8>,
    pub block_number: u64,
    pub tx_index: u32,
    /// Position within the decoded batch (before signature filtering).
    pub msg_index: u32,
}

/// A decoded bam-twitter message, positioned in canonical chain order.
/// Used by Circuit 2 after filtering VerifiedMessages by TWITTER_TAG.
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

// ── Keccak-256 ────────────────────────────────────────────────────────────────

/// Ethereum Keccak-256 (not SHA3-256 — they use different padding).
///
/// Runs in pure software inside the zkVM. Patching tiny-keccak with the SP1
/// keccak256 precompile would reduce cycle cost if this becomes a bottleneck.
pub fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut k = Keccak::v256();
    k.update(data);
    let mut out = [0u8; 32];
    k.finalize(&mut out);
    out
}

// ── EIP-712 ───────────────────────────────────────────────────────────────────

/// Compute the EIP-712 typed-data digest for a BAM message.
///
/// Matches packages/bam-sdk/src/eip712.ts → computeECDSADigest exactly.
///
/// Domain:  { name: "BAM", version: "1", chainId }
/// Struct:  BAMMessage { sender: address, nonce: uint64, contents: bytes }
///
/// ABI encoding rules (EIP-712 §4):
///   address  → 32 bytes, zero-padded left (12 zeros + 20 bytes)
///   uint64   → 32 bytes, zero-padded left as uint256
///   bytes    → keccak256(value), 32 bytes
///   string   → keccak256(utf8(value)), 32 bytes
///   uint256  → 32 bytes big-endian
pub fn eip712_digest(sender: &[u8; 20], nonce: u64, contents: &[u8], chain_id: u64) -> [u8; 32] {
    // Domain separator
    let domain_typehash =
        keccak256(b"EIP712Domain(string name,string version,uint256 chainId)");
    let name_hash = keccak256(b"BAM");
    let version_hash = keccak256(b"1");

    // abi.encode(domainTypeHash, nameHash, versionHash, chainId)
    // 4 × 32 bytes = 128 bytes, zero-initialised (padding is automatic)
    let mut domain_data = [0u8; 128];
    domain_data[0..32].copy_from_slice(&domain_typehash);
    domain_data[32..64].copy_from_slice(&name_hash);
    domain_data[64..96].copy_from_slice(&version_hash);
    // chain_id as uint256: 24 zero bytes then 8 bytes big-endian (u64 → u256)
    domain_data[120..128].copy_from_slice(&chain_id.to_be_bytes());

    let domain_separator = keccak256(&domain_data);

    // Struct hash
    let struct_typehash =
        keccak256(b"BAMMessage(address sender,uint64 nonce,bytes contents)");
    let contents_hash = keccak256(contents);

    // abi.encode(structTypeHash, sender, nonce, keccak256(contents))
    let mut struct_data = [0u8; 128];
    struct_data[0..32].copy_from_slice(&struct_typehash);
    // address: 12 zero bytes then 20 bytes → occupies [32..64], sender at [44..64]
    struct_data[44..64].copy_from_slice(sender);
    // uint64 as uint256: 24 zero bytes then 8 bytes → occupies [64..96], nonce at [88..96]
    struct_data[88..96].copy_from_slice(&nonce.to_be_bytes());
    // keccak256(contents): occupies [96..128]
    struct_data[96..128].copy_from_slice(&contents_hash);

    let struct_hash = keccak256(&struct_data);

    // keccak256("\x19\x01" || domainSeparator || structHash)
    let mut final_data = [0u8; 66];
    final_data[0] = 0x19;
    final_data[1] = 0x01;
    final_data[2..34].copy_from_slice(&domain_separator);
    final_data[34..66].copy_from_slice(&struct_hash);

    keccak256(&final_data)
}

// ── ECDSA verification ────────────────────────────────────────────────────────

/// Recover the Ethereum address from a 65-byte ECDSA signature over a
/// 32-byte pre-hash. Returns None on any failure (bad encoding, high-s, etc.).
///
/// sig_bytes layout: r (32) || s (32) || v (1), v ∈ {27, 28}.
fn ecrecover(digest: &[u8; 32], sig_bytes: &[u8; 65]) -> Option<[u8; 20]> {
    let v = sig_bytes[64];
    let recovery_id = if v >= 27 { v - 27 } else { v };
    let rec_id = RecoveryId::try_from(recovery_id).ok()?;

    let sig = K256Sig::from_slice(&sig_bytes[..64]).ok()?;

    // Reject high-s signatures (canonical form, matches bam-sdk's verifyECDSA).
    // normalize_s() returns Some(lowered) when s was in the upper half → reject.
    if sig.normalize_s().is_some() {
        return None;
    }

    let vk = VerifyingKey::recover_from_prehash(digest, &sig, rec_id).ok()?;

    // Ethereum address = keccak256(uncompressed_pubkey[1..])[12..]
    let encoded = vk.to_encoded_point(false); // uncompressed: 0x04 || x (32) || y (32)
    let hash = keccak256(&encoded.as_bytes()[1..]); // skip 0x04 prefix
    let mut addr = [0u8; 20];
    addr.copy_from_slice(&hash[12..]);
    Some(addr)
}

/// Verify the EIP-712 ECDSA signature on a BAM message.
///
/// Returns true iff the signature recovers to `sender` for the given chain.
/// Matches the reference path in bam-reader (registryAddress == 0x0):
///   verifyECDSA(message, sigHex, message.sender, chainId)
///
/// Without the SP1 secp256k1 precompile patch, k256 runs in pure software
/// (correct, ~5-10× more cycles than the accelerated path).
pub fn verify_ecdsa(
    sender: &[u8; 20],
    nonce: u64,
    contents: &[u8],
    sig: &[u8; 65],
    chain_id: u64,
) -> bool {
    let digest = eip712_digest(sender, nonce, contents, chain_id);
    match ecrecover(&digest, sig) {
        Some(recovered) => &recovered == sender,
        None => false,
    }
}

// ── Blob extraction ───────────────────────────────────────────────────────────

/// Strip the 0x00 padding byte (byte 0) from each field element in [start_fe, end_fe)
/// and concatenate the remaining 31 usable bytes per FE.
///
/// EIP-4844: 4096 FEs × 32 bytes = 131072 bytes per blob.
/// Byte 0 of each FE is forced to 0x00 by the KZG field constraint → 31 usable
/// bytes per FE → 126976 usable bytes per blob.
pub fn extract_segment_bytes(blob: &[u8], start_fe: u16, end_fe: u16) -> Vec<u8> {
    let mut result = Vec::with_capacity((end_fe - start_fe) as usize * 31);
    for fe in start_fe..end_fe {
        let offset = fe as usize * 32 + 1;
        result.extend_from_slice(&blob[offset..offset + 31]);
    }
    result
}

// ── Batch decoding ────────────────────────────────────────────────────────────

/// Parse the BAM batch wire format from extracted segment bytes.
///
/// Returns parallel vecs: decoded messages and their raw 65-byte signatures.
/// Callers must zip them: signatures[i] belongs to messages[i].
///
/// Header (10 bytes, big-endian):
///   byte 0:      version  (must be 0x02)
///   byte 1:      codec    (0x00 = none; 0x01 = zstd — not yet supported)
///   bytes 2..5:  message_count (uint32 BE)
///   bytes 6..9:  payload_len   (uint32 BE)
///
/// Per-message record:
///   20 bytes:  sender
///    8 bytes:  nonce (uint64 BE)
///    4 bytes:  contents_len (uint32 BE)
///    N bytes:  contents (first 32 = contentTag)
///   65 bytes:  signature (scheme 0x01 ECDSA)
///
/// TypeScript ref: packages/bam-sdk/src/batch.ts
pub fn decode_batch(data: &[u8]) -> (Vec<BamMessage>, Vec<[u8; 65]>) {
    if data.len() < 10 {
        return (vec![], vec![]);
    }
    if data[0] != 0x02 {
        return (vec![], vec![]);
    }
    assert_eq!(
        data[1], 0x00,
        "zstd codec (0x01) is not supported in Circuit 1 — add ruzstd decompression"
    );

    let msg_count = u32::from_be_bytes([data[2], data[3], data[4], data[5]]) as usize;
    let payload_len = u32::from_be_bytes([data[6], data[7], data[8], data[9]]) as usize;

    if 10 + payload_len > data.len() {
        return (vec![], vec![]);
    }

    let payload = &data[10..10 + payload_len];
    let mut messages = Vec::with_capacity(msg_count);
    let mut signatures: Vec<[u8; 65]> = Vec::with_capacity(msg_count);
    let mut o = 0;

    for _ in 0..msg_count {
        if o + 20 + 8 + 4 > payload.len() {
            // Truncated record header — matches TypeScript throwing RangeError,
            // which bam-reader classifies as skippedDecode (0 messages).
            return (vec![], vec![]);
        }
        let sender: [u8; 20] = payload[o..o + 20].try_into().unwrap();
        o += 20;
        let nonce = u64::from_be_bytes(payload[o..o + 8].try_into().unwrap());
        o += 8;
        let contents_len = u32::from_be_bytes(payload[o..o + 4].try_into().unwrap()) as usize;
        o += 4;

        if o + contents_len + 65 > payload.len() {
            // Truncated record body — same.
            return (vec![], vec![]);
        }
        let contents = payload[o..o + contents_len].to_vec();
        o += contents_len;
        let sig: [u8; 65] = payload[o..o + 65].try_into().unwrap();
        o += 65;

        messages.push(BamMessage { sender, nonce, contents });
        signatures.push(sig);
    }

    // Trailing bytes after all records: TypeScript throws RangeError →
    // bam-reader classifies as skippedDecode (0 messages).
    if o != payload.len() {
        return (vec![], vec![]);
    }

    (messages, signatures)
}

// ── Message set commitment ────────────────────────────────────────────────────

/// Compute the message set commitment M over a set of verified messages.
///
/// M is Circuit 1's public output and Circuit 2's integrity anchor.
/// Circuit 2 re-derives M from its private inputs and asserts equality,
/// proving its messages are exactly what Circuit 1 certified.
///
/// Messages must be sorted in canonical order before calling:
///   (block_number ASC, tx_index ASC, msg_index ASC)
///
/// Per-message record layout (big-endian):
///   uint32: record_length  = 20+8+4+contents.len()+8+4+4
///   bytes 20: sender
///   uint64:   nonce
///   uint32:   contents_len
///   bytes N:  contents  (includes 32-byte contentTag prefix)
///   uint64:   block_number
///   uint32:   tx_index
///   uint32:   msg_index
///
/// M = sha256( frame(msg_0) || frame(msg_1) || … )
pub fn compute_message_commitment(messages: &[VerifiedMessage]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for msg in messages {
        let record_len =
            (20u32 + 8 + 4 + msg.contents.len() as u32 + 8 + 4 + 4).to_be_bytes();
        hasher.update(record_len);
        hasher.update(msg.sender);
        hasher.update(msg.nonce.to_be_bytes());
        hasher.update((msg.contents.len() as u32).to_be_bytes());
        hasher.update(&msg.contents);
        hasher.update(msg.block_number.to_be_bytes());
        hasher.update(msg.tx_index.to_be_bytes());
        hasher.update(msg.msg_index.to_be_bytes());
    }
    hasher.finalize().into()
}

// ── bam-twitter app pipeline (Circuit 2) ─────────────────────────────────────

/// Parse the bam-twitter app envelope out of a message's contents bytes.
///
/// contents layout:
///   bytes  0..31:  contentTag (caller checks this == TWITTER_TAG before calling)
///   byte  32:      envelope version (must be 0x01)
///   byte  33:      kind (0x00 = post, 0x01 = reply)
///
/// Post payload (from byte 34):
///   bytes 0..7:   timestamp (uint64 BE, Unix seconds)
///   bytes 8..11:  content_len (uint32 BE)
///   bytes 12..:   UTF-8 content
///
/// Reply payload (from byte 34):
///   bytes 0..7:   timestamp
///   bytes 8..39:  parent_message_hash (bytes32)
///   bytes 40..43: content_len
///   bytes 44..:   UTF-8 content
///
/// TypeScript ref: apps/bam-twitter/src/lib/contents-codec.ts
pub fn decode_twitter_contents(contents: &[u8]) -> Option<TwitterMessage> {
    if contents.len() < 34 {
        return None;
    }
    let app = &contents[32..];
    if app[0] != 0x01 {
        return None;
    }
    match app[1] {
        0x00 => {
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
/// First occurrence wins — same rule as bam-store.
///
/// Sort key: (block_number ASC, tx_index ASC, msg_index ASC)
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

/// Compute the timeline root R = sha256 over all tweets in canonical order.
///
/// Per-tweet record:
///   uint32 BE (record length) || sender (20) || nonce BE8 (8) || timestamp BE8 (8) || content (UTF-8)
///
/// TypeScript ref: apps/bam-indexer/src/pipeline.ts → computeTimelineRoot
pub fn compute_timeline_root(timeline: &[IndexedTweet]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for tweet in timeline {
        let content = tweet.tweet.content().as_bytes();
        let record_len = (20u32 + 8 + 8 + content.len() as u32).to_be_bytes();
        hasher.update(record_len);
        hasher.update(tweet.sender);
        hasher.update(tweet.nonce.to_be_bytes());
        hasher.update(tweet.tweet.timestamp().to_be_bytes());
        hasher.update(content);
    }
    hasher.finalize().into()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use k256::ecdsa::SigningKey;

    // ── Helpers ───────────────────────────────────────────────────────────────

    fn test_signing_key() -> SigningKey {
        SigningKey::from_bytes(&[1u8; 32].into()).expect("valid test key")
    }

    fn address_of(key: &SigningKey) -> [u8; 20] {
        let vk = k256::ecdsa::VerifyingKey::from(key);
        let point = vk.to_encoded_point(false);
        let hash = keccak256(&point.as_bytes()[1..]);
        let mut addr = [0u8; 20];
        addr.copy_from_slice(&hash[12..]);
        addr
    }

    fn sign_bam(key: &SigningKey, sender: &[u8; 20], nonce: u64, contents: &[u8], chain_id: u64) -> [u8; 65] {
        let digest = eip712_digest(sender, nonce, contents, chain_id);
        let (sig, recid) = key.sign_prehash_recoverable(&digest).expect("sign failed");
        let mut sig65 = [0u8; 65];
        sig65[..64].copy_from_slice(&sig.to_bytes());
        sig65[64] = recid.to_byte() + 27;
        sig65
    }

    fn make_batch_bytes(sender: &[u8; 20], nonce: u64, contents: &[u8], sig: &[u8; 65]) -> Vec<u8> {
        let payload_len = 20 + 8 + 4 + contents.len() + 65;
        let mut data = vec![0u8; 10 + payload_len];
        data[0] = 0x02;
        data[1] = 0x00;
        data[2..6].copy_from_slice(&1u32.to_be_bytes());
        data[6..10].copy_from_slice(&(payload_len as u32).to_be_bytes());
        let mut o = 10;
        data[o..o + 20].copy_from_slice(sender); o += 20;
        data[o..o + 8].copy_from_slice(&nonce.to_be_bytes()); o += 8;
        data[o..o + 4].copy_from_slice(&(contents.len() as u32).to_be_bytes()); o += 4;
        data[o..o + contents.len()].copy_from_slice(contents); o += contents.len();
        data[o..o + 65].copy_from_slice(sig);
        data
    }

    // ── extract_segment_bytes ─────────────────────────────────────────────────

    #[test]
    fn test_extract_segment_bytes_single_fe() {
        let mut blob = vec![0u8; 131072];
        // FE 0: padding byte 0x00, then bytes 1..31
        for i in 0..31usize {
            blob[1 + i] = (i + 1) as u8;
        }
        let out = extract_segment_bytes(&blob, 0, 1);
        assert_eq!(out.len(), 31);
        assert_eq!(out[0], 1);
        assert_eq!(out[30], 31);
    }

    #[test]
    fn test_extract_segment_bytes_full_blob_length() {
        let blob = vec![0u8; 131072];
        let out = extract_segment_bytes(&blob, 0, 4096);
        assert_eq!(out.len(), 4096 * 31);
    }

    // ── decode_batch ──────────────────────────────────────────────────────────

    #[test]
    fn test_decode_batch_too_short() {
        let (msgs, sigs) = decode_batch(&[0u8; 9]);
        assert!(msgs.is_empty() && sigs.is_empty());
    }

    #[test]
    fn test_decode_batch_bad_version() {
        let mut d = vec![0u8; 10];
        d[0] = 0x01;
        let (msgs, sigs) = decode_batch(&d);
        assert!(msgs.is_empty() && sigs.is_empty());
    }

    #[test]
    fn test_decode_batch_zstd_panics() {
        let mut d = vec![0u8; 10];
        d[0] = 0x02;
        d[1] = 0x01;
        let result = std::panic::catch_unwind(|| decode_batch(&d));
        assert!(result.is_err(), "ZSTD batch must panic");
    }

    #[test]
    fn test_decode_batch_zero_messages() {
        let mut d = vec![0u8; 10];
        d[0] = 0x02;
        let (msgs, sigs) = decode_batch(&d);
        assert!(msgs.is_empty() && sigs.is_empty());
    }

    #[test]
    fn test_decode_batch_one_message_roundtrip() {
        let sender = [0x11u8; 20];
        let nonce = 42u64;
        let contents = b"hello world";
        let sig = [0xAAu8; 65];
        let data = make_batch_bytes(&sender, nonce, contents, &sig);
        let (msgs, sigs) = decode_batch(&data);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].sender, sender);
        assert_eq!(msgs[0].nonce, nonce);
        assert_eq!(msgs[0].contents, contents);
        assert_eq!(sigs[0], sig);
    }

    // ── compute_message_commitment ────────────────────────────────────────────

    #[test]
    fn test_commitment_empty_is_sha256_empty() {
        let m = compute_message_commitment(&[]);
        // sha256("") = e3b0c442...
        assert_eq!(m[0], 0xe3);
        assert_eq!(m[1], 0xb0);
        assert_eq!(m[2], 0xc4);
        assert_ne!(m, [0u8; 32]);
    }

    #[test]
    fn test_commitment_is_deterministic() {
        let msg = VerifiedMessage {
            sender: [0x11u8; 20],
            nonce: 1,
            contents: b"test".to_vec(),
            block_number: 100,
            tx_index: 0,
            msg_index: 0,
        };
        assert_eq!(
            compute_message_commitment(std::slice::from_ref(&msg)),
            compute_message_commitment(&[msg])
        );
    }

    #[test]
    fn test_commitment_differs_by_field() {
        let base = VerifiedMessage {
            sender: [0x11u8; 20],
            nonce: 1,
            contents: b"test".to_vec(),
            block_number: 100,
            tx_index: 0,
            msg_index: 0,
        };
        let mut other = base.clone();
        other.nonce = 2;
        assert_ne!(
            compute_message_commitment(&[base]),
            compute_message_commitment(&[other])
        );
    }

    // ── eip712_digest + verify_ecdsa ──────────────────────────────────────────

    #[test]
    fn test_eip712_digest_deterministic() {
        let sender = [0u8; 20];
        assert_eq!(
            eip712_digest(&sender, 1, b"hello", 1),
            eip712_digest(&sender, 1, b"hello", 1)
        );
    }

    #[test]
    fn test_eip712_digest_chain_id_matters() {
        let sender = [0u8; 20];
        assert_ne!(
            eip712_digest(&sender, 1, b"hello", 1),
            eip712_digest(&sender, 1, b"hello", 2)
        );
    }

    #[test]
    fn test_verify_ecdsa_valid_signature() {
        let key = test_signing_key();
        let sender = address_of(&key);
        let nonce = 7u64;
        let contents = b"valid message contents";
        let chain_id = 11155111u64;
        let sig = sign_bam(&key, &sender, nonce, contents, chain_id);
        assert!(verify_ecdsa(&sender, nonce, contents, &sig, chain_id));
    }

    #[test]
    fn test_verify_ecdsa_wrong_sender_fails() {
        let key = test_signing_key();
        let sender = address_of(&key);
        let nonce = 7u64;
        let contents = b"message";
        let chain_id = 1u64;
        let sig = sign_bam(&key, &sender, nonce, contents, chain_id);
        let wrong_sender = [0xFFu8; 20];
        assert!(!verify_ecdsa(&wrong_sender, nonce, contents, &sig, chain_id));
    }

    #[test]
    fn test_verify_ecdsa_wrong_contents_fails() {
        let key = test_signing_key();
        let sender = address_of(&key);
        let nonce = 1u64;
        let chain_id = 1u64;
        let sig = sign_bam(&key, &sender, nonce, b"original", chain_id);
        assert!(!verify_ecdsa(&sender, nonce, b"tampered", &sig, chain_id));
    }
}
