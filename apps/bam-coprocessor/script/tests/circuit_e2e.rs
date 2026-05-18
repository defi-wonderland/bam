//! End-to-end circuit test.
//!
//! Builds a synthetic blob containing a real BAM batch with one signed
//! message, generates a real KZG proof against the mainnet trusted setup,
//! runs the SP1 circuit in execute (simulation) mode, and asserts that the
//! committed M matches the value computed directly via the shared lib.
//!
//! No bam-reader instance or blob archive needed — everything is synthetic.
//! Run with: cargo test --test circuit_e2e -- --nocapture

use bam_coprocessor_lib::{
    compute_message_commitment, eip712_digest, ReaderBatch, VerifiedMessage,
};
use c_kzg::{ethereum_kzg_settings, Blob};
use k256::ecdsa::SigningKey;
use sha2::{Digest, Sha256};
use tiny_keccak::Hasher;
use sp1_sdk::{
    blocking::{Prover, ProverClient},
    include_elf, Elf, SP1Stdin,
};

const BAM_READER_ELF: Elf = include_elf!("bam-reader-program");

const CHAIN_ID: u64 = 11155111;

// ── Key + signing helpers ──────────────────────────────────────────────────────

fn test_key() -> SigningKey {
    SigningKey::from_bytes(&[42u8; 32].into()).expect("valid key")
}

fn address_of(key: &SigningKey) -> [u8; 20] {
    use k256::ecdsa::VerifyingKey;
    let vk = VerifyingKey::from(key);
    let point = vk.to_encoded_point(false);
    // keccak256 of uncompressed pubkey bytes (skip 0x04 prefix)
    let mut keccak = tiny_keccak::Keccak::v256();
    keccak.update(&point.as_bytes()[1..]);
    let mut hash = [0u8; 32];
    tiny_keccak::Hasher::finalize(keccak, &mut hash);
    let mut addr = [0u8; 20];
    addr.copy_from_slice(&hash[12..]);
    addr
}

fn sign_message(key: &SigningKey, sender: &[u8; 20], nonce: u64, contents: &[u8]) -> [u8; 65] {
    let digest = eip712_digest(sender, nonce, contents, CHAIN_ID);
    let (sig, recid) = key.sign_prehash_recoverable(&digest).expect("sign failed");
    let mut sig65 = [0u8; 65];
    sig65[..64].copy_from_slice(&sig.to_bytes());
    sig65[64] = recid.to_byte() + 27;
    sig65
}

// ── Blob construction ─────────────────────────────────────────────────────────

/// Pack `data` into a 131072-byte EIP-4844 blob (31 usable bytes per FE).
/// Byte 0 of each FE is always 0x00 (required by the field constraint).
fn pack_into_blob(data: &[u8]) -> Vec<u8> {
    let mut blob = vec![0u8; 131072];
    let mut src = data;
    for fe in 0..4096usize {
        let chunk_len = src.len().min(31);
        if chunk_len == 0 {
            break;
        }
        blob[fe * 32 + 1..fe * 32 + 1 + chunk_len].copy_from_slice(&src[..chunk_len]);
        src = &src[chunk_len..];
    }
    blob
}

/// Encode one BAM batch with a single message into wire format bytes.
fn encode_batch(sender: &[u8; 20], nonce: u64, contents: &[u8], sig: &[u8; 65]) -> Vec<u8> {
    let payload_len = 20 + 8 + 4 + contents.len() + 65;
    let mut data = vec![0u8; 10 + payload_len];
    data[0] = 0x02; // version
    data[1] = 0x00; // codec: none
    data[2..6].copy_from_slice(&1u32.to_be_bytes()); // msg_count
    data[6..10].copy_from_slice(&(payload_len as u32).to_be_bytes()); // payload_len
    let mut o = 10;
    data[o..o + 20].copy_from_slice(sender); o += 20;
    data[o..o + 8].copy_from_slice(&nonce.to_be_bytes()); o += 8;
    data[o..o + 4].copy_from_slice(&(contents.len() as u32).to_be_bytes()); o += 4;
    data[o..o + contents.len()].copy_from_slice(contents); o += contents.len();
    data[o..o + 65].copy_from_slice(sig);
    data
}

// ── KZG ───────────────────────────────────────────────────────────────────────

fn kzg_from_blob(blob_bytes: &[u8]) -> (Vec<u8>, Vec<u8>, [u8; 32]) {
    let settings = ethereum_kzg_settings(0);
    let blob = Blob::from_bytes(blob_bytes).expect("blob must be 131072 bytes");
    let commitment = settings.blob_to_kzg_commitment(&blob).expect("commitment");
    let c_bytes: [u8; 48] = commitment.to_bytes().into_inner();
    let proof = settings
        .compute_blob_kzg_proof(&blob, &c_kzg::Bytes48::from(c_bytes))
        .expect("proof");
    let p_bytes: [u8; 48] = proof.to_bytes().into_inner();
    let c_hash: [u8; 32] = Sha256::digest(c_bytes).into();
    let mut vh = [0u8; 32];
    vh[0] = 0x01;
    vh[1..].copy_from_slice(&c_hash[1..]);
    (c_bytes.to_vec(), p_bytes.to_vec(), vh)
}

// ── Test ──────────────────────────────────────────────────────────────────────

#[test]
fn circuit_executes_and_m_matches() {
    sp1_sdk::utils::setup_logger();

    let key = test_key();
    let sender = address_of(&key);
    let nonce = 1u64;
    // contents = 32-byte content_tag (zeros) + app payload
    let mut contents = vec![0u8; 32];
    contents.extend_from_slice(b"hello from the circuit test");
    let sig = sign_message(&key, &sender, nonce, &contents);

    let batch_wire = encode_batch(&sender, nonce, &contents, &sig);
    let blob_bytes = pack_into_blob(&batch_wire);
    let (commitment, opening_proof, versioned_hash) = kzg_from_blob(&blob_bytes);

    let batch = ReaderBatch {
        versioned_hash,
        commitment,
        opening_proof,
        content_tag: [0u8; 32],
        decoder: [0u8; 20],
        sig_registry: [0u8; 20],
        block_number: 1,
        tx_index: 0,
        start_fe: 0,
        end_fe: 4096,
        blob_bytes,
    };

    let mut stdin = SP1Stdin::new();
    stdin.write(&CHAIN_ID);
    stdin.write(&vec![batch]);

    let client = ProverClient::from_env();
    let (output, report) = client
        .execute(BAM_READER_ELF, stdin)
        .run()
        .expect("SP1 execution failed");

    // ── Parse public outputs ──────────────────────────────────────────────────
    let raw = output.as_slice();
    let chain_id_out = u64::from_le_bytes(raw[0..8].try_into().unwrap());
    let m_circuit: [u8; 32] = raw[8..40].try_into().unwrap();
    let batch_count = u32::from_le_bytes(raw[40..44].try_into().unwrap());

    println!("chain_id:          {}", chain_id_out);
    println!("M (circuit):       0x{}", hex::encode(m_circuit));
    println!("batches processed: {}", batch_count);
    println!("total cycles:      {}", report.total_instruction_count());

    assert_eq!(chain_id_out, CHAIN_ID);
    assert_eq!(batch_count, 1);

    // ── Recompute M independently via the shared lib ──────────────────────────
    let expected_msg = VerifiedMessage {
        sender,
        nonce,
        contents: contents.clone(),
        block_number: 1,
        tx_index: 0,
        msg_index: 0,
    };
    let m_lib = compute_message_commitment(&[expected_msg]);
    println!("M (lib):           0x{}", hex::encode(m_lib));

    assert_eq!(
        m_circuit, m_lib,
        "circuit M must match lib-computed M"
    );
}
