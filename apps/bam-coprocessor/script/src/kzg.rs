//! KZG commitment + opening-proof helpers using `c-kzg` with the embedded
//! mainnet trusted setup. Single source of truth for hosts that need to
//! reproduce the EIP-4844 versioned hash for a blob.

use c_kzg::{ethereum_kzg_settings, Blob};
use sha2::{Digest, Sha256};

/// Generate (`commitment_bytes`, `opening_proof_bytes`, `versioned_hash`)
/// for a 131072-byte blob payload. Panics on malformed input.
pub fn generate_kzg_proof(blob_bytes: &[u8]) -> (Vec<u8>, Vec<u8>, [u8; 32]) {
    let settings = ethereum_kzg_settings(0);
    let blob = Blob::from_bytes(blob_bytes).expect("blob must be 131072 bytes");
    let commitment = settings
        .blob_to_kzg_commitment(&blob)
        .expect("commitment failed");
    let commitment_bytes: [u8; 48] = commitment.to_bytes().into_inner();
    let proof = settings
        .compute_blob_kzg_proof(&blob, &c_kzg::Bytes48::from(commitment_bytes))
        .expect("proof failed");
    let proof_bytes: [u8; 48] = proof.to_bytes().into_inner();
    let c_hash: [u8; 32] = Sha256::digest(commitment_bytes).into();
    let mut versioned_hash = [0u8; 32];
    versioned_hash[0] = 0x01;
    versioned_hash[1..].copy_from_slice(&c_hash[1..]);
    (commitment_bytes.to_vec(), proof_bytes.to_vec(), versioned_hash)
}
