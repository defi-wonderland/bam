//! Circuit 1 host script — BAM reader coprocessor.
//!
//! Loads blob batches from a JSON cache, generates KZG proofs using the mainnet
//! trusted setup (c-kzg), feeds them to the reader guest program, and reports
//! the message commitment M.
//!
//! Cache format (--cache <path>):
//!   JSON array of objects with fields: versioned_hash, block_number, tx_index,
//!   log_index, tx_hash, startFE, endFE, blob_bytes_hex (0x-prefixed).
//!   Fields content_tag, decoder, and sig_registry are optional (default 0x0).
//!
//!   The default path (../bam-indexer/cache/batches.json) assumes bam-indexer is
//!   checked out alongside this repo. bam-indexer is not committed here — it was
//!   the first-iteration indexer used to download the demo blobs. To build your
//!   own cache, run bam-indexer against a Sepolia node or download blobs directly
//!   from the Beacon API and assemble the JSON manually.  Alternatively, use
//!   prove-from-reader which fetches blobs live from a bam-reader instance.
//!
//! Usage:
//!   cargo run --release --bin prove-reader -- --execute --cache /path/to/batches.json

use bam_coprocessor_lib::ReaderBatch;
use bam_coprocessor_script::{parse_public_values, print_public_values};
use c_kzg::{ethereum_kzg_settings, Blob};
use clap::Parser;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use sp1_sdk::{
    blocking::{ProveRequest, Prover, ProverClient},
    include_elf, Elf, ProvingKey, SP1Stdin,
};

const BAM_READER_ELF: Elf = include_elf!("bam-reader-program");

// ── CLI ───────────────────────────────────────────────────────────────────────

#[derive(Parser, Debug)]
#[command(about = "BAM reader coprocessor host (Circuit 1)")]
struct Args {
    /// Execute without generating a proof (fast, for development).
    #[arg(long)]
    execute: bool,

    /// Generate a real SP1 STARK proof (slow — needs local GPU or Succinct network).
    #[arg(long)]
    prove: bool,

    /// Proof format for --prove mode.
    ///
    /// compressed (default): a STARK that Circuit 2 can recursively verify inside the SP1 zkVM.
    /// groth16: a succinct BN254 proof verifiable by snarkjs in the browser, a Solidity contract,
    ///   or any standard Groth16 verifier. Cannot be consumed by Circuit 2's recursive verify step.
    ///   Use this when Circuit 1 is the final output (no Circuit 2), e.g. for client-side UX.
    #[arg(long, default_value = "compressed", value_parser = ["compressed", "groth16"])]
    proof_type: String,

    /// Ethereum chain ID to use for EIP-712 signature verification.
    #[arg(long, default_value = "1")]
    chain_id: u64,

    /// Path to the blob batch cache file.
    #[arg(long, default_value = "../bam-indexer/cache/batches.json")]
    cache: String,

    /// Save output to a file. In --execute mode: JSON with public values + cycle stats.
    /// In --prove mode: serialized SP1 proof (binary, loadable by show-proof).
    #[arg(long)]
    output: Option<String>,
}

// ── Cache deserialization ─────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReaderCachedBatch {
    versioned_hash: String,
    block_number: u64,
    tx_index: u32,
    #[allow(dead_code)]
    log_index: u32,
    #[allow(dead_code)]
    tx_hash: String,
    #[serde(rename = "startFE")]
    start_fe: u16,
    #[serde(rename = "endFE")]
    end_fe: u16,
    blob_bytes_hex: String,
    #[serde(default)]
    content_tag: Option<String>,
    #[serde(default)]
    decoder: Option<String>,
    #[serde(default)]
    sig_registry: Option<String>,
}

fn decode_hex32(s: &str) -> [u8; 32] {
    let s = s.strip_prefix("0x").unwrap_or(s);
    hex::decode(s)
        .expect("invalid hex")
        .try_into()
        .expect("expected 32 bytes")
}

fn decode_hex20(s: &str) -> [u8; 20] {
    let s = s.strip_prefix("0x").unwrap_or(s);
    hex::decode(s)
        .expect("invalid hex")
        .try_into()
        .expect("expected 20 bytes")
}

fn decode_hex_bytes(s: &str) -> Vec<u8> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    hex::decode(s).expect("invalid hex")
}

// ── KZG (c-kzg, mainnet trusted setup) ───────────────────────────────────────

/// Generate a real KZG commitment and blob proof using the mainnet trusted setup.
/// The versioned_hash is 0x01 || sha256(C)[1..], matching the L1 cache exactly.
fn generate_kzg_proof(blob_bytes: &[u8]) -> (Vec<u8>, Vec<u8>, [u8; 32]) {
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

// ── Main ──────────────────────────────────────────────────────────────────────

fn main() {
    sp1_sdk::utils::setup_logger();

    let args = Args::parse();
    if args.execute == args.prove {
        eprintln!("Error: specify exactly one of --execute or --prove");
        std::process::exit(1);
    }

    println!("BAM reader coprocessor — Circuit 1 (real EIP-4844 KZG)");
    println!("chain_id = {}", args.chain_id);
    println!("Loading batches from {}…", args.cache);

    let json = std::fs::read_to_string(&args.cache)
        .unwrap_or_else(|_| panic!(
            "cache not found at {}\n\
             Provide a blob cache JSON via --cache <path>. See the module doc for the expected format.",
            args.cache
        ));
    let cached: Vec<ReaderCachedBatch> =
        serde_json::from_str(&json).expect("invalid cache JSON");
    println!("  Loaded {} blob batches", cached.len());

    println!("Generating KZG proofs…");
    let batches: Vec<ReaderBatch> = cached
        .iter()
        .map(|c| {
            let blob_bytes = decode_hex_bytes(&c.blob_bytes_hex);
            let (commitment, opening_proof, vh) = generate_kzg_proof(&blob_bytes);

            // Verify the computed versioned_hash matches what the indexer saw on L1.
            let l1_vh = decode_hex32(&c.versioned_hash);
            assert_eq!(
                vh, l1_vh,
                "versioned_hash mismatch for block={} tx={} — blob data may be corrupt",
                c.block_number, c.tx_index
            );

            ReaderBatch {
                versioned_hash: vh,
                commitment,
                opening_proof,
                content_tag: c
                    .content_tag
                    .as_deref()
                    .map(decode_hex32)
                    .unwrap_or([0u8; 32]),
                decoder: c
                    .decoder
                    .as_deref()
                    .map(decode_hex20)
                    .unwrap_or([0u8; 20]),
                sig_registry: c
                    .sig_registry
                    .as_deref()
                    .map(decode_hex20)
                    .unwrap_or([0u8; 20]),
                block_number: c.block_number,
                tx_index: c.tx_index,
                start_fe: c.start_fe,
                end_fe: c.end_fe,
                blob_bytes,
            }
        })
        .collect();
    println!("  Done.\n");

    let mut stdin = SP1Stdin::new();
    stdin.write(&args.chain_id);
    stdin.write(&batches);

    let client = ProverClient::from_env();

    if args.execute {
        println!("Mode: execute (no proof)\n");
        let (output, report) = client
            .execute(BAM_READER_ELF, stdin)
            .run()
            .expect("execution failed");

        let pv = parse_public_values(output.as_slice());
        print_public_values(&pv);

        let total = report.total_instruction_count();
        println!("\nCycles:     {}", total);
        println!("Prover gas (PGUs): {:?}", report.gas());

        if let Some(path) = &args.output {
            let json = serde_json::json!({
                "public_values": pv,
                "cycles": { "total": total },
            });
            std::fs::write(path, serde_json::to_string_pretty(&json).unwrap())
                .unwrap_or_else(|e| eprintln!("Warning: could not write output: {}", e));
            println!("\nResults saved to {}", path);
        }
    } else {
        println!("Mode: prove\n");
        println!(
            "NOTE: proof generation is slow.\n\
             Set SP1_PROVER=network and NETWORK_PRIVATE_KEY=0x<key> for remote proving."
        );

        let pk = client.setup(BAM_READER_ELF).expect("setup failed");
        let prove_req = client.prove(&pk, stdin);
        let proof = if args.proof_type == "groth16" {
            prove_req.groth16().run().expect("prove failed")
        } else {
            prove_req.compressed().run().expect("prove failed")
        };
        println!("Proof generated! ({})", args.proof_type);

        let is_mock = std::env::var("SP1_PROVER").unwrap_or_default() == "mock";
        if is_mock {
            println!("(mock mode — skipping cryptographic verification)");
        } else {
            client
                .verify(&proof, pk.verifying_key(), None)
                .expect("verify failed");
            println!("Proof verified!");
        }

        if let Some(path) = &args.output {
            proof.save(path).unwrap_or_else(|e| eprintln!("Warning: could not save proof: {}", e));
            println!("Proof saved to {}", path);
        }
    }
}
