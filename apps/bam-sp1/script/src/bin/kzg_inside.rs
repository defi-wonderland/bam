//! kzg-inside host: KZG verification inside the zkVM.
//!
//! Generates toy KZG proofs for every blob in the bam-indexer cache, feeds
//! them to the program-kzg-internal guest, and reports cycle counts from
//! execute mode (no real STARK proof generated).
//!
//! Toy setup: τ = TAU_SCALAR (known constant). Production would use the real
//! EIP-4844 trusted setup τ·G₂ from the KZG ceremony so that commitments can
//! be verified against versioned_hashes on L1.
//!
//! Why no MSM needed on the host:
//!   With a transparent (known) τ, commitment = f(τ)·G₁ where f(τ) is a
//!   plain Horner evaluation in Fr followed by a single G1 scalar mul.
//!   The opening proof is π = ((f(τ)−y)/(τ−z))·G₁, also one scalar mul.
//!   This avoids building or storing the full SRS [τⁱ·G₁], keeping host
//!   setup to a few milliseconds regardless of polynomial degree.
//!
//! Usage:
//!   cargo run --release --bin kzg-inside

use bls12_381::{G1Affine, G1Projective, G2Affine, G2Projective, Scalar};
use sha2::{Digest, Sha256};
use sp1_sdk::{
    blocking::{Prover, ProverClient},
    include_elf, Elf, SP1Stdin,
};
use bam_twitter_lib::KZGBlobInput;
use serde::Deserialize;

/// Toy trusted-setup secret. Any nonzero scalar works; this is NOT secret.
const TAU_SCALAR: u64 = 12_345;

const BAM_KZG_INTERNAL_ELF: Elf = include_elf!("bam-kzg-internal");

// ── Cache types (mirrors main.rs) ─────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedBatch {
    versioned_hash: String,
    block_number: u64,
    tx_index: u32,
    log_index: u32,
    #[allow(dead_code)]
    tx_hash: String,
    #[serde(rename = "startFE")]
    start_fe: u16,
    #[serde(rename = "endFE")]
    end_fe: u16,
    blob_bytes_hex: String,
}

fn decode_hex32(s: &str) -> [u8; 32] {
    let s = s.strip_prefix("0x").unwrap_or(s);
    hex::decode(s).expect("invalid hex").try_into().expect("expected 32 bytes")
}

fn decode_hex_vec(s: &str) -> Vec<u8> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    hex::decode(s).expect("invalid hex")
}

fn load_cached_batches(path: &str) -> Vec<CachedBatch> {
    let json = std::fs::read_to_string(path)
        .unwrap_or_else(|_| panic!("cache not found at {path}\nRun bam-indexer first."));
    serde_json::from_str(&json).expect("invalid cache JSON")
}

// ── KZG toy setup helpers ─────────────────────────────────────────────────────

/// Parse one 32-byte blob field element (big-endian, MSB always 0x00) into Fr.
fn fe_to_scalar(fe: &[u8; 32]) -> Scalar {
    let mut le = *fe;
    le.reverse();
    Option::from(Scalar::from_bytes(&le)).expect("field element >= r")
}

/// SHA-256 output → BLS12-381 scalar (same logic as guest).
fn sha256_to_scalar(data: &[u8]) -> Scalar {
    let digest: [u8; 32] = Sha256::digest(data).into();
    let mut wide = [0u8; 64];
    for i in 0..32 {
        wide[i] = digest[31 - i];
    }
    Scalar::from_bytes_wide(&wide)
}

/// Horner evaluation of Σ coeffs[i]·xⁱ at point z (same logic as guest).
fn horner(coeffs: &[Scalar], z: Scalar) -> Scalar {
    let mut acc = Scalar::from(0u64);
    for c in coeffs.iter().rev() {
        acc = acc * z + c;
    }
    acc
}

/// Generate a toy KZG commitment and opening proof for one blob.
///
/// Returns (commitment_bytes, opening_proof_bytes) as Vec<u8> (48 bytes each).
fn generate_kzg_proof(blob_bytes: &[u8], tau: Scalar) -> (Vec<u8>, Vec<u8>) {
    let n = blob_bytes.len() / 32;
    let coeffs: Vec<Scalar> = (0..n)
        .map(|i| {
            let fe: [u8; 32] = blob_bytes[i * 32..(i + 1) * 32].try_into().unwrap();
            fe_to_scalar(&fe)
        })
        .collect();

    // C = f(τ)·G₁
    let f_tau = horner(&coeffs, tau);
    let commitment_bytes = G1Affine::from(G1Projective::generator() * f_tau).to_compressed().to_vec();

    // z = sha256(C ∥ blob_bytes) mod r  — must match the guest's derivation exactly
    let z = {
        let mut data = Vec::with_capacity(48 + blob_bytes.len());
        data.extend_from_slice(commitment_bytes.as_slice());
        data.extend_from_slice(blob_bytes);
        sha256_to_scalar(&data)
    };

    // y = f(z)
    let y = horner(&coeffs, z);

    // π = ((f(τ) − y) / (τ − z)) · G₁
    let tau_minus_z: Scalar = tau - z;
    let inv: Scalar = Option::<Scalar>::from(tau_minus_z.invert())
        .expect("τ == z (sha256 collision with this τ — pick a different TAU_SCALAR)");
    let q_tau: Scalar = (f_tau - y) * inv;
    let opening_proof_bytes =
        G1Affine::from(G1Projective::generator() * q_tau).to_compressed().to_vec();

    (commitment_bytes, opening_proof_bytes)
}

// ── Main ──────────────────────────────────────────────────────────────────────

fn main() {
    sp1_sdk::utils::setup_logger();

    let tau = Scalar::from(TAU_SCALAR);

    // τ·G₂ is the only trusted-setup point the guest needs for verification.
    let tau_g2_bytes = G2Affine::from(G2Projective::generator() * tau).to_compressed();

    println!("kzg-inside — KZG verification inside the zkVM (toy setup, τ={})", TAU_SCALAR);
    println!("Loading blob batches from ../bam-indexer/cache/batches.json…");
    let cached = load_cached_batches("../bam-indexer/cache/batches.json");
    println!("  Loaded {} blob batches", cached.len());

    println!("Generating KZG proofs…");
    let inputs: Vec<KZGBlobInput> = cached
        .into_iter()
        .map(|b| {
            let blob_bytes = decode_hex_vec(&b.blob_bytes_hex);
            let (commitment, opening_proof) = generate_kzg_proof(&blob_bytes, tau);
            KZGBlobInput {
                versioned_hash: decode_hex32(&b.versioned_hash),
                block_number: b.block_number,
                tx_index: b.tx_index,
                log_index: b.log_index,
                start_fe: b.start_fe,
                end_fe: b.end_fe,
                blob_bytes,
                commitment,
                opening_proof,
            }
        })
        .collect();
    println!("  Done.\n");

    let mut stdin = SP1Stdin::new();
    // Write as Vec<u8>: serde's derive only covers arrays up to [T; 32].
    stdin.write(&tau_g2_bytes.to_vec());
    stdin.write(&inputs);

    let client = ProverClient::from_env();

    println!("Mode: execute (no proof)\n");
    let (output, report) = client
        .execute(BAM_KZG_INTERNAL_ELF, stdin)
        .run()
        .expect("execution failed");

    // Decode public values: R (32) || count (4 LE) || commitments (48 each)
    let raw = output.as_slice();
    let timeline_root: [u8; 32] = raw[0..32].try_into().unwrap();
    let count = u32::from_le_bytes(raw[32..36].try_into().unwrap()) as usize;
    let kzg_commitments: Vec<[u8; 48]> = (0..count)
        .map(|i| raw[36 + i * 48..36 + (i + 1) * 48].try_into().unwrap())
        .collect();

    println!("Timeline root R:  0x{}", hex::encode(timeline_root));
    println!(
        "KZG commitments ({}) — verified inside circuit:",
        kzg_commitments.len()
    );
    for c in &kzg_commitments {
        println!("  0x{}", hex::encode(c));
    }

    let cycles = report.total_instruction_count();
    println!("\nCycles: {}", cycles);
    println!(
        "Phase 2 baseline (sha256 binding): 89M cycles  →  {:.1}× overhead for KZG-inside",
        cycles as f64 / 89_000_000.0
    );

    // The pipeline is identical so R must match the TypeScript reference.
    let expected: [u8; 32] = hex::decode(
        "30126f1c725b81fd92348c92ff15a8017585329cfde6d43e07ed0f178f20e2a5",
    )
    .unwrap()
    .try_into()
    .unwrap();
    assert_eq!(timeline_root, expected, "R mismatch — pipeline diverged");
    println!("\n✓ R matches TypeScript reference");
    println!(
        "\nNote: τ={} is a toy secret (known). Production uses the real EIP-4844 ceremony.",
        TAU_SCALAR
    );
}
