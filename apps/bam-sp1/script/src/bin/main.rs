//! BAM Twitter ZK host script.
//!
//! The host loads the blob data, feeds it to the guest program as private
//! inputs, then either executes (no proof, instant) or proves (generates a
//! real STARK proof).
//!
//! Usage:
//!   cargo run --release -- --execute   # fast, no proof
//!   cargo run --release -- --prove     # generates a real proof (slow)

use clap::Parser;
use sp1_sdk::{
    blocking::{ProveRequest, Prover, ProverClient},
    include_elf, Elf, ProvingKey, SP1Stdin,
};
use bam_twitter_lib::BlobBatch;
use serde::Deserialize;

/// The compiled guest program ELF.
/// sp1-build compiles program/ and embeds it here at build time.
const BAM_TWITTER_ELF: Elf = include_elf!("bam-twitter-program");

#[derive(Parser, Debug)]
#[command(about = "BAM Twitter ZK indexer host")]
struct Args {
    /// Execute the program without generating a proof (fast, for development).
    #[arg(long)]
    execute: bool,

    /// Generate a real SP1 proof (slow — needs local GPU or Succinct network).
    #[arg(long)]
    prove: bool,

    /// Path to the bam-indexer cache file.
    #[arg(long, default_value = "../bam-indexer/cache/batches.json")]
    cache: String,
}

/// Shape of one entry in bam-indexer/cache/batches.json.
/// Mirrors CachedBatch in apps/bam-indexer/src/chain-fetcher.ts.
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
    let bytes = hex::decode(s).expect("invalid hex");
    bytes.try_into().expect("expected 32 bytes")
}

fn decode_hex_vec(s: &str) -> Vec<u8> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    hex::decode(s).expect("invalid hex")
}

fn load_batches(path: &str) -> Vec<BlobBatch> {
    let json = std::fs::read_to_string(path)
        .unwrap_or_else(|_| panic!("cache not found at {path}\nRun bam-indexer first to populate it."));

    let cached: Vec<CachedBatch> = serde_json::from_str(&json).expect("invalid cache JSON");

    cached
        .into_iter()
        .map(|c| BlobBatch {
            versioned_hash: decode_hex32(&c.versioned_hash),
            block_number: c.block_number,
            tx_index: c.tx_index,
            log_index: c.log_index,
            start_fe: c.start_fe,
            end_fe: c.end_fe,
            blob_bytes: decode_hex_vec(&c.blob_bytes_hex),
        })
        .collect()
}

fn main() {
    sp1_sdk::utils::setup_logger();

    let args = Args::parse();
    if args.execute == args.prove {
        eprintln!("Error: specify exactly one of --execute or --prove");
        std::process::exit(1);
    }

    // ── Load inputs from bam-indexer cache ───────────────────────────────────
    println!("Loading blob batches from {}…", args.cache);
    let batches = load_batches(&args.cache);
    println!("  Loaded {} blob batches", batches.len());

    // ── Build SP1 stdin ───────────────────────────────────────────────────────
    // Everything written here becomes private inputs to the guest.
    let mut stdin = SP1Stdin::new();
    stdin.write(&batches);

    // ── Execute or prove ──────────────────────────────────────────────────────
    let client = ProverClient::from_env();

    if args.execute {
        println!("\nMode: execute (no proof)\n");

        // TODO (Phase 2): this will panic on the todo!() stubs in lib/ until
        // the pipeline functions are implemented.
        let (output, report) = client
            .execute(BAM_TWITTER_ELF, stdin)
            .run()
            .expect("execution failed");

        // Decode public values from the binary layout committed by the guest:
        //   [0..32]   timeline_root R
        //   [32..36]  blob count (u32 LE)
        //   [36..]    blob_sha256s — sha256(blob_bytes) computed inside the circuit
        let raw = output.as_slice();
        let timeline_root: [u8; 32] = raw[0..32].try_into().unwrap();
        let count = u32::from_le_bytes(raw[32..36].try_into().unwrap()) as usize;
        let blob_sha256s: Vec<[u8; 32]> = (0..count)
            .map(|i| raw[36 + i * 32..36 + (i + 1) * 32].try_into().unwrap())
            .collect();

        println!("Timeline root R:  0x{}", hex::encode(timeline_root));
        println!("Blob sha256s ({}) — computed inside the circuit:", blob_sha256s.len());
        for h in &blob_sha256s {
            println!("  0x{}", hex::encode(h));
        }

        println!("\nCycles: {}", report.total_instruction_count());

        // Verify R matches the TypeScript reference implementation.
        let expected: [u8; 32] = hex::decode(
            "30126f1c725b81fd92348c92ff15a8017585329cfde6d43e07ed0f178f20e2a5"
        ).unwrap().try_into().unwrap();
        assert_eq!(timeline_root, expected, "R mismatch — Rust and TypeScript pipelines disagree");
        println!("\n✓ R matches TypeScript reference");

    } else {
        println!("\nMode: prove\n");
        println!("NOTE: real proving is slow (minutes locally, seconds on Succinct network).");
        println!("Set SP1_PROVER=network and SP1_PRIVATE_KEY=... for remote proving.");

        let pk = client.setup(BAM_TWITTER_ELF).expect("setup failed");
        let proof = client.prove(&pk, stdin).run().expect("prove failed");
        println!("Proof generated!");

        // Mock proofs have no cryptographic content — skip verification.
        // With a real prover (CPU or network), this will do full STARK verification.
        let is_mock = std::env::var("SP1_PROVER").unwrap_or_default() == "mock";
        if is_mock {
            println!("(mock mode — skipping cryptographic verification)");
        } else {
            client
                .verify(&proof, pk.verifying_key(), None)
                .expect("verify failed");
            println!("Proof verified!");
        }

        // TODO (Phase 3): save proof to disk / submit to on-chain verifier contract.
    }
}
