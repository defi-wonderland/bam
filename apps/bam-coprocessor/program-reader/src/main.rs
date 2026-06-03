//! Circuit 1 guest program — BAM reader coprocessor.
//!
//! Proves that a specific BAM message at msg_index was correctly derived from
//! a specific EIP-4844 blob.
//!
//!   Step 0 — Assert decoder == 0x0 and sig_registry == 0x0.
//!   Step 1 — Bind commitment to L1: assert versioned_hash == 0x01 || sha256(C)[1..].
//!   Step 2 — KZG opening verification via kzg-rs (succinctlabs/kzg-rs).
//!   Step 3 — Extract usable segment bytes (strip 0x00 padding byte per FE).
//!   Step 4 — Decode the BAM blob wire format into messages + raw signatures.
//!   Step 5 — Assert ECDSA signature at msg_index (EIP-712, secp256k1).
//!   Step 6 — Compute message_hash = keccak256(sender ‖ content_tag ‖ nonce_be8 ‖ contents).
//!
//! Public outputs (152 bytes, fixed):
//!   [0..8]     chain_id       (u64 LE)
//!   [8..40]    versioned_hash (32 bytes)
//!   [40..72]   content_tag    (32 bytes)
//!   [72..74]   start_fe       (u16 LE)
//!   [74..76]   end_fe         (u16 LE)
//!   [76..84]   block_number   (u64 LE)
//!   [84..88]   tx_index       (u32 LE)
//!   [88..92]   msg_index      (u32 LE)
//!   [92..112]  sender         (20 bytes)
//!   [112..120] nonce          (u64 LE)
//!   [120..152] message_hash   (32 bytes)

#![no_main]
sp1_zkvm::entrypoint!(main);

use kzg_rs::{get_kzg_settings, Blob, Bytes48, KzgProof};
use sha2::{Digest, Sha256};

use bam_coprocessor_lib::{
    compute_message_hash, decode_bam_payload, extract_segment_bytes, verify_ecdsa, BlobInput,
};

pub fn main() {
    let chain_id: u64 = sp1_zkvm::io::read::<u64>();
    let blob: BlobInput = sp1_zkvm::io::read::<BlobInput>();
    let msg_index: u32 = sp1_zkvm::io::read::<u32>();

    let kzg_settings = get_kzg_settings();

    // ── Step 0: scope assertion ───────────────────────────────────────────────
    assert_eq!(
        blob.decoder,
        [0u8; 20],
        "blob uses on-chain decoder — outside circuit scope"
    );
    assert_eq!(
        blob.sig_registry,
        [0u8; 20],
        "blob uses on-chain sig registry — outside circuit scope"
    );

    let commitment_bytes: [u8; 48] = blob
        .commitment
        .as_slice()
        .try_into()
        .expect("commitment must be 48 bytes");
    let proof_bytes: [u8; 48] = blob
        .opening_proof
        .as_slice()
        .try_into()
        .expect("opening_proof must be 48 bytes");

    // ── Step 1: versioned_hash binding (L1 anchor) ────────────────────────────
    let c_hash: [u8; 32] = Sha256::digest(commitment_bytes).into();
    assert_eq!(
        blob.versioned_hash[0],
        0x01,
        "versioned_hash version byte must be 0x01"
    );
    assert_eq!(
        &blob.versioned_hash[1..],
        &c_hash[1..],
        "commitment does not match L1 versioned_hash"
    );

    // ── Step 2: KZG opening verification ──────────────────────────────────────
    let blob_arr: [u8; 131_072] = blob
        .blob_bytes
        .as_slice()
        .try_into()
        .expect("blob must be exactly 131072 bytes");
    let kzg_blob   = Blob(blob_arr);
    let commitment = Bytes48::from_slice(&commitment_bytes).expect("invalid commitment");
    let proof      = Bytes48::from_slice(&proof_bytes).expect("invalid proof");
    let is_valid =
        KzgProof::verify_blob_kzg_proof(kzg_blob, &commitment, &proof, &kzg_settings)
            .expect("KZG verification internal error");
    assert!(is_valid, "KZG proof invalid");

    // ── Step 3: extract usable bytes from the blob segment ────────────────────
    let segment = extract_segment_bytes(&blob.blob_bytes, blob.start_fe, blob.end_fe);

    // ── Step 4: decode BAM wire format (full blob — validates trailing bytes) ─
    let (messages, sigs) = decode_bam_payload(&segment);

    // ── Step 5: assert ECDSA signature at msg_index ────────────────────────────
    assert!(
        (msg_index as usize) < messages.len(),
        "msg_index {} out of range (blob has {} messages)",
        msg_index,
        messages.len()
    );
    let msg = &messages[msg_index as usize];
    let sig = &sigs[msg_index as usize];
    assert!(
        verify_ecdsa(&msg.sender, &blob.content_tag, msg.nonce, &msg.contents, sig, chain_id),
        "ECDSA verification failed for msg_index {}",
        msg_index
    );

    // ── Step 6: compute per-message hash ──────────────────────────────────────
    let message_hash = compute_message_hash(&msg.sender, &blob.content_tag, msg.nonce, &msg.contents);

    // ── Commit public values (152 bytes) ──────────────────────────────────────
    sp1_zkvm::io::commit_slice(&chain_id.to_le_bytes());
    sp1_zkvm::io::commit_slice(&blob.versioned_hash);
    sp1_zkvm::io::commit_slice(&blob.content_tag);
    sp1_zkvm::io::commit_slice(&blob.start_fe.to_le_bytes());
    sp1_zkvm::io::commit_slice(&blob.end_fe.to_le_bytes());
    sp1_zkvm::io::commit_slice(&blob.block_number.to_le_bytes());
    sp1_zkvm::io::commit_slice(&blob.tx_index.to_le_bytes());
    sp1_zkvm::io::commit_slice(&msg_index.to_le_bytes());
    sp1_zkvm::io::commit_slice(&msg.sender);
    sp1_zkvm::io::commit_slice(&msg.nonce.to_le_bytes());
    sp1_zkvm::io::commit_slice(&message_hash);
}
