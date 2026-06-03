//! Circuit 1 host script — reads live blob data from a bam-reader HTTP server.
//!
//! Fetches confirmed batches for a given content tag, downloads the raw blob
//! bytes, generates KZG proofs (via c-kzg), and feeds everything to the reader
//! guest program.  This is the production path; prove-reader.rs reads from a
//! static JSON cache and is kept only for quick local iteration.
//!
//! Blob fetching strategy:
//!   1. GET /blobs/:versionedHash from bam-reader (requires blob archive configured).
//!   2. On failure, fall back to the Ethereum beacon chain (Sepolia only):
//!      estimates the beacon slot from the execution block number via linear
//!      interpolation, then searches ±50 slots on the Lodestar Sepolia public API.
//!
//! Usage:
//!   cargo run --release --bin prove-from-reader -- --execute --content-tag 0xf0fea9...
//!
//! Remote proving (Succinct network):
//!   SP1_PROVER=network NETWORK_PRIVATE_KEY=0x<key> \
//!     cargo run --release --bin prove-from-reader -- --prove --content-tag 0xf0fea9...
//!
//! Known limitations:
//!   startFE / endFE are not stored in bam-store's BatchRow and therefore not
//!   available via /batches.  Both default to [0, 4096) here.

use std::io::Read;

use bam_coprocessor_lib::BlobInput;
use bam_coprocessor_script::{parse_message_public_values, print_message_public_values};
use c_kzg::{ethereum_kzg_settings, Blob};
use clap::Parser;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use sp1_sdk::{
    blocking::{ProveRequest, Prover, ProverClient},
    include_elf, Elf, ProvingKey, SP1Stdin,
};

const BAM_READER_ELF: Elf = include_elf!("bam-reader-program");

// ── Beacon chain fallback (Sepolia) ───────────────────────────────────────────
// Used when bam-reader's /blobs endpoint fails.  Calibration points map
// execution block numbers to beacon slots via linear interpolation.

const BEACON_URL_SEPOLIA: &str = "https://lodestar-sepolia.chainsafe.io";
const REF_EXEC_A: f64 = 10_926_101.0;
const REF_SLOT_A: f64 = 10_338_743.0;
const REF_EXEC_B: f64 = 10_933_021.0;
const REF_SLOT_B: f64 = 10_345_720.0;
const BEACON_SEARCH_RADIUS: i64 = 50;

// ── CLI ───────────────────────────────────────────────────────────────────────

#[derive(Parser, Debug)]
#[command(about = "BAM reader coprocessor host — reads from a live bam-reader instance")]
struct Args {
    /// Execute without generating a proof (fast, for development).
    #[arg(long)]
    execute: bool,

    /// Generate a real SP1 STARK proof (set SP1_PROVER=network for remote proving).
    #[arg(long)]
    prove: bool,

    /// Base URL of the bam-reader HTTP server.
    #[arg(long, default_value = "http://localhost:7777")]
    reader_url: String,

    /// 0x-prefixed bytes32 content tag to filter batches.
    #[arg(long)]
    content_tag: String,

    /// Ethereum chain ID for EIP-712 signature verification.
    #[arg(long, default_value = "1")]
    chain_id: u64,

    /// Index of the message within the decoded batch to prove.
    #[arg(long, default_value = "0")]
    msg_index: u32,

    /// Save output to a file. In --execute mode: JSON with public values + cycle stats.
    /// In --prove mode: serialized SP1 proof (binary, loadable by show-proof).
    #[arg(long)]
    output: Option<String>,
}

// ── bam-reader API types ──────────────────────────────────────────────────────

/// One entry from `GET /batches` — only the fields we need.
/// bam-reader encodes Bytes32/Address as 0x-prefixed hex and bigint as decimal
/// string; plain number fields (blockNumber, txIndex) come as JSON numbers.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiBatch {
    blob_versioned_hash: String,
    content_tag: String,
    block_number: Option<u64>,
    tx_index: Option<u32>,
}

#[derive(Deserialize)]
struct BatchesResponse {
    batches: Vec<ApiBatch>,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn decode_hex32(s: &str) -> [u8; 32] {
    let s = s.strip_prefix("0x").unwrap_or(s);
    hex::decode(s)
        .expect("invalid hex")
        .try_into()
        .expect("expected 32 bytes")
}

/// Fetch raw blob bytes, trying bam-reader first then the beacon chain.
fn fetch_blob_bytes(
    reader_url: &str,
    versioned_hash_hex: &str,
    versioned_hash: &[u8; 32],
    exec_block: u64,
    chain_id: u64,
) -> Vec<u8> {
    let url = format!("{}/blobs/{}", reader_url, versioned_hash_hex);
    match ureq::get(&url).call() {
        Ok(resp) => {
            let mut bytes = Vec::with_capacity(131_072);
            match resp.into_reader().read_to_end(&mut bytes) {
                Ok(_) if bytes.len() == 131_072 => return bytes,
                Ok(_) => eprintln!(
                    "  bam-reader blob: got {} bytes (expected 131072), trying beacon chain…",
                    bytes.len()
                ),
                Err(e) => eprintln!("  bam-reader blob read failed ({}), trying beacon chain…", e),
            }
        }
        Err(e) => eprintln!("  bam-reader blob fetch failed ({}), trying beacon chain…", e),
    }

    let beacon_url = match chain_id {
        11155111 => BEACON_URL_SEPOLIA,
        other => panic!(
            "bam-reader blob fetch failed and no beacon fallback is configured for chain {other}.\n\
             Only Sepolia (11155111) has a built-in beacon fallback."
        ),
    };

    eprintln!("  fetching from beacon chain (block {exec_block})…");
    fetch_blob_from_beacon(beacon_url, exec_block, versioned_hash)
        .unwrap_or_else(|e| panic!("beacon fallback failed: {e}"))
}

fn estimate_beacon_slot(exec_block: u64) -> u64 {
    let slope = (REF_SLOT_B - REF_SLOT_A) / (REF_EXEC_B - REF_EXEC_A);
    (REF_SLOT_A + slope * (exec_block as f64 - REF_EXEC_A)).round() as u64
}

fn get_exec_block_at_slot(beacon_url: &str, slot: u64) -> Option<u64> {
    let url = format!("{}/eth/v2/beacon/blocks/{}", beacon_url, slot);
    let resp = ureq::get(&url).call().ok()?;
    let json: serde_json::Value = resp.into_json().ok()?;
    json["data"]["message"]["body"]["execution_payload"]["block_number"]
        .as_str()
        .and_then(|s| s.parse().ok())
}

fn fetch_blob_from_beacon(
    beacon_url: &str,
    exec_block: u64,
    want_vh: &[u8; 32],
) -> Result<Vec<u8>, String> {
    let approx = estimate_beacon_slot(exec_block);

    let slot = {
        let mut found = None;
        'search: for delta in 0..=BEACON_SEARCH_RADIUS {
            for d in if delta == 0 { vec![0] } else { vec![-delta, delta] } {
                let candidate = (approx as i64 + d) as u64;
                if get_exec_block_at_slot(beacon_url, candidate) == Some(exec_block) {
                    found = Some(candidate);
                    break 'search;
                }
            }
        }
        found.ok_or_else(|| {
            format!("could not find beacon slot for exec block {exec_block} (searched ±{BEACON_SEARCH_RADIUS} of slot {approx})")
        })?
    };

    eprintln!("  found beacon slot {slot} for exec block {exec_block}");

    let url = format!("{}/eth/v1/beacon/blob_sidecars/{}", beacon_url, slot);
    let resp = ureq::get(&url).call().map_err(|e| e.to_string())?;
    let json: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
    let sidecars = json["data"]
        .as_array()
        .ok_or_else(|| "no 'data' array in sidecar response".to_string())?;

    for sidecar in sidecars {
        let commitment_hex = sidecar["kzg_commitment"]
            .as_str()
            .ok_or_else(|| "missing kzg_commitment in sidecar".to_string())?;
        let c_bytes = hex::decode(commitment_hex.trim_start_matches("0x"))
            .map_err(|e| e.to_string())?;
        let c_hash: [u8; 32] = Sha256::digest(&c_bytes).into();
        let mut vh = [0u8; 32];
        vh[0] = 0x01;
        vh[1..].copy_from_slice(&c_hash[1..]);
        if &vh == want_vh {
            let blob_hex = sidecar["blob"]
                .as_str()
                .ok_or_else(|| "missing blob field in sidecar".to_string())?;
            let blob_bytes = hex::decode(blob_hex.trim_start_matches("0x"))
                .map_err(|e| e.to_string())?;
            if blob_bytes.len() != 131_072 {
                return Err(format!("unexpected blob size: {} bytes", blob_bytes.len()));
            }
            return Ok(blob_bytes);
        }
    }

    Err(format!(
        "no sidecar matched versioned hash 0x{} at slot {slot}",
        hex::encode(want_vh)
    ))
}

/// Generate a real KZG commitment + blob proof using the mainnet trusted setup.
fn generate_kzg_proof_real(blob_bytes: &[u8]) -> (Vec<u8>, Vec<u8>, [u8; 32]) {
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
    if !args.content_tag.starts_with("0x") || args.content_tag.len() != 66 {
        eprintln!("Error: --content-tag must be a 0x-prefixed 32-byte hex value (66 chars)");
        std::process::exit(1);
    }

    println!("BAM reader coprocessor — Circuit 1 (bam-reader source)");
    println!("reader_url:  {}", args.reader_url);
    println!("content_tag: {}", args.content_tag);
    println!("chain_id:    {}", args.chain_id);

    // ── Step 1: fetch confirmed batch list ────────────────────────────────────
    let batches_url = format!(
        "{}/batches?contentTag={}&status=confirmed&limit=1",
        args.reader_url, args.content_tag
    );
    println!("\nFetching batches from {}…", batches_url);

    let resp: BatchesResponse = ureq::get(&batches_url)
        .call()
        .unwrap_or_else(|e| panic!("GET /batches failed: {}", e))
        .into_json()
        .expect("GET /batches: invalid JSON response");

    let mut api_batches = resp.batches;
    println!("  {} confirmed batch(es) found", api_batches.len());

    if api_batches.is_empty() {
        println!("Nothing to prove.");
        return;
    }

    // Use the first confirmed batch (sorted by chain order).
    api_batches.sort_by(|a, b| {
        a.block_number
            .cmp(&b.block_number)
            .then(a.tx_index.cmp(&b.tx_index))
    });
    let ab = &api_batches[0];

    // ── Step 2: fetch blob + generate KZG proof ───────────────────────────────
    let block_number = ab.block_number.expect("confirmed batch must have block_number");
    let tx_index = ab.tx_index.expect("confirmed batch must have tx_index");
    let l1_vh = decode_hex32(&ab.blob_versioned_hash);

    println!("Fetching blob and generating KZG proof…");
    println!(
        "  block={} tx={} vh=0x{}…",
        block_number, tx_index, &ab.blob_versioned_hash[2..10]
    );

    let blob_bytes = fetch_blob_bytes(
        &args.reader_url,
        &ab.blob_versioned_hash,
        &l1_vh,
        block_number,
        args.chain_id,
    );

    let (commitment, opening_proof, computed_vh) = generate_kzg_proof_real(&blob_bytes);
    assert_eq!(
        computed_vh, l1_vh,
        "versioned_hash mismatch (block={} tx={}) — blob may be corrupt",
        block_number, tx_index
    );

    let blob = BlobInput {
        versioned_hash: l1_vh,
        commitment,
        opening_proof,
        content_tag:  decode_hex32(&ab.content_tag),
        decoder:      [0u8; 20],
        sig_registry: [0u8; 20],
        block_number,
        tx_index,
        start_fe: 0,
        end_fe:   4096,
        blob_bytes,
    };

    println!("  Done.\n");

    // ── Step 3: feed to SP1 ───────────────────────────────────────────────────
    let mut stdin = SP1Stdin::new();
    stdin.write(&args.chain_id);
    stdin.write(&blob);
    stdin.write(&args.msg_index);

    let client = ProverClient::from_env();

    if args.execute {
        println!("Mode: execute (no proof)\n");
        let (output, report) = client
            .execute(BAM_READER_ELF, stdin)
            .run()
            .expect("execution failed");

        let raw = output.as_slice();
        let pv = parse_message_public_values(raw);
        print_message_public_values(&pv);

        let total_cycles = report.total_instruction_count();
        println!("\nCycles: {}", total_cycles);

        if let Some(path) = &args.output {
            let json = serde_json::json!({
                "public_values": pv,
                "cycles": { "total": total_cycles },
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
        let proof = client.prove(&pk, stdin).compressed().run().expect("prove failed");
        println!("Proof generated!");

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
