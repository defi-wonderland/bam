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

use bam_coprocessor_lib::BlobInput;
use bam_coprocessor_script::{
    blob_fetch::{decode_hex20, decode_hex32, decode_hex_bytes},
    kzg::generate_kzg_proof,
    parse_message_public_values, print_message_public_values,
    sp1_runner::{execute_c1, prove_c1},
};
use clap::Parser;
use serde::Deserialize;
use sp1_sdk::{include_elf, Elf};

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

    /// Which cached batch to prove (0-indexed into the cache JSON array).
    #[arg(long, default_value = "0")]
    batch_index: usize,

    /// Which message inside the batch to prove (per-message C1 redesign).
    #[arg(long, default_value = "0")]
    msg_index: u32,

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

    if args.batch_index >= cached.len() {
        panic!(
            "--batch-index {} out of range (cache has {} batches)",
            args.batch_index,
            cached.len()
        );
    }
    let c = &cached[args.batch_index];
    println!(
        "Proving batch[{}] block={} tx={} msg_index={}…",
        args.batch_index, c.block_number, c.tx_index, args.msg_index
    );

    let blob_bytes = decode_hex_bytes(&c.blob_bytes_hex);
    let (commitment, opening_proof, vh) =
        generate_kzg_proof(&blob_bytes).expect("kzg proof generation failed");
    let l1_vh = decode_hex32(&c.versioned_hash);
    assert_eq!(
        vh, l1_vh,
        "versioned_hash mismatch for block={} tx={} — blob data may be corrupt",
        c.block_number, c.tx_index
    );

    let batch = BlobInput {
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
    };
    println!("  KZG ready.\n");

    if args.execute {
        println!("Mode: execute (no proof)\n");
        let out = execute_c1(BAM_READER_ELF, args.chain_id, &batch, args.msg_index)
            .unwrap_or_else(|e| panic!("{e}"));
        let pv = parse_message_public_values(&out.public_values).expect("invalid public values");
        print_message_public_values(&pv);
        println!("\nCycles: {}", out.total_cycles);

        if let Some(path) = &args.output {
            let json = serde_json::json!({
                "public_values": pv,
                "cycles": { "total": out.total_cycles },
            });
            std::fs::write(path, serde_json::to_string_pretty(&json).unwrap())
                .unwrap_or_else(|e| eprintln!("Warning: could not write output: {}", e));
            println!("\nResults saved to {}", path);
        }
    } else {
        println!("Mode: prove ({})\n", args.proof_type);
        let proof = prove_c1(
            BAM_READER_ELF,
            args.chain_id,
            &batch,
            args.msg_index,
            args.proof_type == "groth16",
        )
        .unwrap_or_else(|e| panic!("{e}"));
        println!("Proof generated! ({})", args.proof_type);

        if let Some(path) = &args.output {
            proof
                .save(path)
                .unwrap_or_else(|e| eprintln!("Warning: could not save proof: {}", e));
            println!("Proof saved to {}", path);
        }
    }
}
