//! kzg-inside guest: KZG verification *inside* the zkVM.
//!
//! For each blob the circuit:
//!   1. Decompresses the KZG commitment C and opening proof π (G1 points).
//!   2. Derives the Fiat-Shamir challenge  z = sha256(C_bytes ∥ blob_bytes) mod r.
//!   3. Evaluates y = f(z) by Horner's rule over the blob field-element coefficients.
//!   4. Verifies the KZG opening:
//!        e(C − y·G₁, G₂) == e(π, τ·G₂ − z·G₂)
//!      using multi_miller_loop + final_exponentiation (one shared final-exp ≈ 30% cheaper
//!      than two separate pairing() calls).
//!   5. Runs the bam-twitter indexing pipeline over the verified bytes.
//!
//! Public outputs committed to in the proof:
//!   [0..32]   timeline_root R
//!   [32..36]  blob count (u32 LE)
//!   [36..]    KZG commitments — one compressed G1 point (48 bytes) per blob
//!
//! Toy setup note:
//!   τ is a known scalar supplied via the trusted setup G2 point τ·G₂.
//!   Production would use the real EIP-4844 KZG ceremony τ·G₂ and
//!   evaluation-form polynomials so that C can be verified against the
//!   versioned_hashes in BlobBatchRegistered events on L1.

#![no_main]
sp1_zkvm::entrypoint!(main);

use bls12_381::{
    multi_miller_loop, G1Affine, G1Projective, G2Affine, G2Prepared, G2Projective, Gt, Scalar,
};
use sha2::{Digest, Sha256};

use bam_twitter_lib::{
    build_timeline, compute_timeline_root, decode_batch, decode_twitter_contents,
    extract_segment_bytes, IndexedTweet, KZGBlobInput,
};

/// keccak256("bam-twitter.v1") — same constant as the sha256-binding guest.
const TWITTER_TAG: [u8; 32] = [
    0xf0, 0xfe, 0xa9, 0x4f, 0xfd, 0x2a, 0xe3, 0x2e,
    0xd8, 0x78, 0xc5, 0x7e, 0x34, 0x27, 0xbb, 0xff,
    0xab, 0x46, 0xd3, 0x33, 0xd0, 0x98, 0x37, 0xbc,
    0x64, 0x0d, 0x95, 0x27, 0x95, 0x09, 0x07, 0x18,
];

/// Parse one 32-byte blob field element (big-endian, MSB always 0x00) into a
/// BLS12-381 scalar. Reversing to little-endian is required by Scalar::from_bytes.
fn fe_to_scalar(fe: &[u8; 32]) -> Scalar {
    let mut le = *fe;
    le.reverse();
    // Safe: MSB of every valid EIP-4844 FE is 0x00, so the value fits in 248 bits << r.
    Option::from(Scalar::from_bytes(&le)).expect("blob field element >= scalar field order")
}

/// Reduce a SHA-256 digest to a BLS12-381 scalar via Scalar::from_bytes_wide
/// (interprets 64 bytes little-endian mod r; upper 32 bytes are zero-padded).
fn sha256_to_scalar(data: &[u8]) -> Scalar {
    let digest = Sha256::digest(data);
    let mut wide = [0u8; 64];
    for i in 0..32 {
        wide[i] = digest[31 - i]; // big-endian digest → little-endian limbs
    }
    Scalar::from_bytes_wide(&wide)
}

/// Horner's method: evaluate polynomial Σ coeffs[i]·xⁱ at point z.
fn horner(coeffs: &[Scalar], z: Scalar) -> Scalar {
    let mut acc = Scalar::from(0u64);
    for c in coeffs.iter().rev() {
        acc = acc * z + c;
    }
    acc
}

pub fn main() {
    // ── Step 1: read trusted setup point τ·G₂ ────────────────────────────────
    // Passed as a public input so the verifier can confirm which setup was used.
    // Vec<u8> because serde's derive only supports arrays up to [T; 32].
    let tau_g2_vec: Vec<u8> = sp1_zkvm::io::read::<Vec<u8>>();
    let tau_g2_bytes: [u8; 96] = tau_g2_vec.as_slice().try_into().expect("τ·G₂ must be 96 bytes");
    let tau_g2: G2Affine = Option::from(G2Affine::from_compressed(&tau_g2_bytes))
        .expect("invalid τ·G₂ point");

    // ── Step 2: read blob inputs ──────────────────────────────────────────────
    let inputs: Vec<KZGBlobInput> = sp1_zkvm::io::read::<Vec<KZGBlobInput>>();

    let mut commitments: Vec<[u8; 48]> = Vec::with_capacity(inputs.len());

    let mut all_tweets: Vec<IndexedTweet> = Vec::new();

    for input in &inputs {
        // ── 2a. Decompress KZG points ─────────────────────────────────────────
        let commitment_bytes: [u8; 48] = input.commitment.as_slice().try_into()
            .expect("commitment must be 48 bytes");
        let proof_bytes: [u8; 48] = input.opening_proof.as_slice().try_into()
            .expect("opening_proof must be 48 bytes");
        let c_affine: G1Affine = Option::from(G1Affine::from_compressed(&commitment_bytes))
            .expect("invalid commitment point");
        let pi_affine: G1Affine = Option::from(G1Affine::from_compressed(&proof_bytes))
            .expect("invalid opening proof point");

        // ── 2b. Parse blob as polynomial coefficients ─────────────────────────
        // Each 32-byte field element becomes one Fr coefficient.
        let n = input.blob_bytes.len() / 32;
        let coeffs: Vec<Scalar> = (0..n)
            .map(|i| {
                let fe: [u8; 32] = input.blob_bytes[i * 32..(i + 1) * 32]
                    .try_into()
                    .unwrap();
                fe_to_scalar(&fe)
            })
            .collect();

        // ── 2c. Fiat-Shamir challenge: z = sha256(C ∥ blob_bytes) mod r ───────
        let z = {
            let mut data = Vec::with_capacity(48 + input.blob_bytes.len());
            data.extend_from_slice(&input.commitment);
            data.extend_from_slice(&input.blob_bytes);
            sha256_to_scalar(&data)
        };

        // ── 2d. Evaluate f(z) ─────────────────────────────────────────────────
        let y = horner(&coeffs, z);

        // ── 2e. KZG pairing check ─────────────────────────────────────────────
        // Verify: e(C − y·G₁, G₂) == e(π, τ·G₂ − z·G₂)
        // Rearranged: e(C − y·G₁, G₂) · e(−π, τ·G₂ − z·G₂) == 1 in Gₜ
        //
        // multi_miller_loop shares the final exponentiation across both pairings
        // (~30% cheaper than two separate pairing() calls).
        let y_g1  = G1Affine::from(G1Projective::generator() * y);
        let lhs_g1 = G1Affine::from(G1Projective::from(c_affine) + G1Projective::from(-y_g1));

        let z_g2   = G2Affine::from(G2Projective::generator() * z);
        let rhs_g2 = G2Affine::from(G2Projective::from(tau_g2) + G2Projective::from(-z_g2));

        let ml = multi_miller_loop(&[
            (&lhs_g1,    &G2Prepared::from(G2Affine::generator())),
            (&(-pi_affine), &G2Prepared::from(rhs_g2)),
        ]);
        assert_eq!(ml.final_exponentiation(), Gt::identity(), "KZG proof invalid");

        commitments.push(commitment_bytes);

        // ── 2f. Run the bam-twitter pipeline over the verified bytes ──────────
        let segment = extract_segment_bytes(&input.blob_bytes, input.start_fe, input.end_fe);
        let messages = decode_batch(&segment);

        for (msg_index, msg) in messages.into_iter().enumerate() {
            if msg.contents.len() < 32 || msg.contents[..32] != TWITTER_TAG {
                continue;
            }
            if let Some(tweet) = decode_twitter_contents(&msg.contents) {
                all_tweets.push(IndexedTweet {
                    sender: msg.sender,
                    nonce: msg.nonce,
                    block_number: input.block_number,
                    tx_index: input.tx_index,
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
    // Layout: R (32) || count (4 LE) || commitments (48 each)
    sp1_zkvm::io::commit_slice(&timeline_root);
    sp1_zkvm::io::commit_slice(&(commitments.len() as u32).to_le_bytes());
    for c in &commitments {
        sp1_zkvm::io::commit_slice(c);
    }
}
