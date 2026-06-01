//! Circuit 1 guest program — BAM reader coprocessor.
//!
//! For each blob batch this circuit:
//!   Step 0 — Assert decoder == 0x0 and sig_registry == 0x0.
//!   Step 1 — Bind commitment to L1: assert versioned_hash == 0x01 || sha256(C)[1..].
//!   Step 2 — KZG opening verification via kzg-rs (succinctlabs/kzg-rs).
//!             Delegates Fiat-Shamir challenge, barycentric evaluation, and BLS12-381
//!             pairing to kzg-rs, which routes EC operations through SP1 precompiles.
//!             The mainnet trusted setup is embedded in the kzg-rs binary at compile
//!             time; the host cannot supply a fake one.
//!   Step 3 — Extract usable segment bytes (strip 0x00 padding byte per FE).
//!   Step 4 — Decode the BAM batch wire format into messages + raw signatures.
//!   Step 5 — Verify each ECDSA signature (EIP-712 typed data, secp256k1).
//!   Step 6 — Sort verified messages and compute message-set commitment M.
//!
//! Public outputs:
//!   [0..8]      chain_id (u64 LE)
//!   [8..40]     M = sha256(canonical message stream) (32 bytes)
//!   [40..44]    batch_count (u32 LE)
//!   Per batch   (124 bytes each):
//!     [0..32]   versioned_hash
//!     [32..80]  KZG commitment (48 bytes)
//!     [80..112] content_tag (32 bytes)
//!     [112..120] block_number (u64 LE)
//!     [120..124] tx_index (u32 LE)

#![no_main]
sp1_zkvm::entrypoint!(main);

use kzg_rs::{get_kzg_settings, Blob, Bytes48, KzgProof};
use sha2::{Digest, Sha256};

use bam_coprocessor_lib::{
    compute_message_commitment, decode_batch, extract_segment_bytes, verify_ecdsa, ReaderBatch,
    VerifiedMessage,
};

pub fn main() {
    let chain_id: u64 = sp1_zkvm::io::read::<u64>();
    let batches: Vec<ReaderBatch> = sp1_zkvm::io::read::<Vec<ReaderBatch>>();

    let kzg_settings = get_kzg_settings();

    let mut all_verified: Vec<VerifiedMessage> = Vec::new();

    for batch in &batches {
        // ── Step 0: scope assertion ───────────────────────────────────────────
        assert_eq!(
            batch.decoder,
            [0u8; 20],
            "batch uses on-chain decoder — outside circuit scope"
        );
        assert_eq!(
            batch.sig_registry,
            [0u8; 20],
            "batch uses on-chain sig registry — outside circuit scope"
        );

        let commitment_bytes: [u8; 48] = batch
            .commitment
            .as_slice()
            .try_into()
            .expect("commitment must be 48 bytes");
        let proof_bytes: [u8; 48] = batch
            .opening_proof
            .as_slice()
            .try_into()
            .expect("opening_proof must be 48 bytes");

        // ── Step 1: versioned_hash binding (L1 anchor) ───────────────────────
        // versioned_hash = 0x01 || sha256(C)[1..]  (EIP-4844 §6.1)
        let c_hash: [u8; 32] = Sha256::digest(commitment_bytes).into();
        assert_eq!(
            batch.versioned_hash[0],
            0x01,
            "versioned_hash version byte must be 0x01"
        );
        assert_eq!(
            &batch.versioned_hash[1..],
            &c_hash[1..],
            "commitment does not match L1 versioned_hash"
        );

        // ── Step 2: KZG opening verification ─────────────────────────────────
        let blob_arr: [u8; 131_072] = batch
            .blob_bytes
            .as_slice()
            .try_into()
            .expect("blob must be exactly 131072 bytes");
        let blob       = Blob(blob_arr);
        let commitment = Bytes48::from_slice(&commitment_bytes).expect("invalid commitment");
        let proof      = Bytes48::from_slice(&proof_bytes).expect("invalid proof");
        let is_valid =
            KzgProof::verify_blob_kzg_proof(blob, &commitment, &proof, &kzg_settings)
                .expect("KZG verification internal error");
        assert!(is_valid, "KZG proof invalid");

        // ── Step 3: extract usable bytes from the blob segment ────────────────
        let segment = extract_segment_bytes(&batch.blob_bytes, batch.start_fe, batch.end_fe);

        // ── Step 4: decode BAM wire format ────────────────────────────────────
        let (messages, sigs) = decode_batch(&segment);

        // ── Step 5: verify ECDSA signatures, drop invalid messages ────────────
        for (msg_index, (msg, sig)) in messages.iter().zip(sigs.iter()).enumerate() {
            if verify_ecdsa(&msg.sender, &batch.content_tag, msg.nonce, &msg.contents, sig, chain_id) {
                all_verified.push(VerifiedMessage {
                    sender: msg.sender,
                    nonce: msg.nonce,
                    contents: msg.contents.clone(),
                    block_number: batch.block_number,
                    tx_index: batch.tx_index,
                    msg_index: msg_index as u32,
                });
            }
        }
    }

    // ── Step 6: sort and commit ───────────────────────────────────────────────
    all_verified.sort_by(|a, b| {
        a.block_number
            .cmp(&b.block_number)
            .then(a.tx_index.cmp(&b.tx_index))
            .then(a.msg_index.cmp(&b.msg_index))
    });

    let m = compute_message_commitment(&all_verified);

    // ── Commit public values ──────────────────────────────────────────────────
    sp1_zkvm::io::commit_slice(&chain_id.to_le_bytes());
    sp1_zkvm::io::commit_slice(&m);
    sp1_zkvm::io::commit_slice(&(batches.len() as u32).to_le_bytes());
    for batch in &batches {
        sp1_zkvm::io::commit_slice(&batch.versioned_hash);
        sp1_zkvm::io::commit_slice(&batch.commitment);
        sp1_zkvm::io::commit_slice(&batch.content_tag);
        sp1_zkvm::io::commit_slice(&batch.block_number.to_le_bytes());
        sp1_zkvm::io::commit_slice(&batch.tx_index.to_le_bytes());
    }
}
