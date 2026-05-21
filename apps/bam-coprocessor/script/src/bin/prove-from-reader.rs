//! Circuit 1 host script — reads live blob data from a bam-reader HTTP server.
//!
//! Fetches confirmed batches for a given content tag, downloads the raw blob
//! bytes, generates KZG proofs (via c-kzg), and feeds everything to the reader
//! guest program.  This is the production path; prove-reader.rs reads from a
//! static JSON cache and is kept only for quick local iteration.
//!
//! Usage:
//!   cargo run --release --bin prove-from-reader -- --execute --content-tag 0xf0fea9...
//!
//! Remote proving (Succinct network):
//!   SP1_PROVER=network SP1_PRIVATE_KEY=<key> \
//!     cargo run --release --bin prove-from-reader -- --prove --content-tag 0xf0fea9...
//!
//! Known limitations:
//!   startFE / endFE are not stored in bam-store's BatchRow and therefore not
//!   available via /batches.  Both default to [0, 4096) here.
//!
//!   The GET /blobs/{hash} endpoint requires bam-reader to be running with a blob
//!   archive directory configured.  That feature was not deployed on the bam-reader
//!   instance when this was built, so the blob-fetching path has not been tested
//!   end-to-end.  The demo was run against blobs downloaded and cached separately.

use std::io::Read;

use bam_coprocessor_lib::{compute_message_commitment, ReaderBatch, VerifiedMessage};
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

    /// Maximum number of confirmed batches to fetch.
    #[arg(long, default_value = "1000")]
    limit: u32,

    /// Save output to a file. In --execute mode: JSON with public values + cycle stats.
    /// In --prove mode: serialized SP1 proof (binary, loadable by show-proof).
    #[arg(long)]
    output: Option<String>,
}

// ── bam-reader API types ──────────────────────────────────────────────────────

/// One entry from `GET /messages` — only the fields we need.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiMessage {
    sender: String,
    nonce: String,
    contents: String,
    block_number: Option<u64>,
    tx_index: Option<u32>,
    message_index_within_batch: Option<u32>,
}

#[derive(Deserialize)]
struct MessagesResponse {
    messages: Vec<ApiMessage>,
}

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
        "{}/batches?contentTag={}&status=confirmed&limit={}",
        args.reader_url, args.content_tag, args.limit
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

    // Sort deterministically before processing.
    api_batches.sort_by(|a, b| {
        a.block_number
            .cmp(&b.block_number)
            .then(a.tx_index.cmp(&b.tx_index))
    });

    // ── Step 2: fetch blobs + generate KZG proofs ─────────────────────────────
    println!("Fetching blobs and generating KZG proofs…");
    let total = api_batches.len();

    let batches: Vec<ReaderBatch> = api_batches
        .iter()
        .enumerate()
        .map(|(i, ab)| {
            let blob_url = format!("{}/blobs/{}", args.reader_url, ab.blob_versioned_hash);
            let blob_resp = ureq::get(&blob_url).call().unwrap_or_else(|e| {
                panic!(
                    "GET /blobs/{} failed: {}\n\
                     Tip: is bam-reader running with a blob archive directory configured?",
                    ab.blob_versioned_hash, e
                )
            });

            let mut blob_bytes: Vec<u8> = Vec::with_capacity(131_072);
            blob_resp
                .into_reader()
                .read_to_end(&mut blob_bytes)
                .expect("reading blob body failed");

            let (commitment, opening_proof, computed_vh) = generate_kzg_proof_real(&blob_bytes);

            let l1_vh = decode_hex32(&ab.blob_versioned_hash);
            assert_eq!(
                computed_vh, l1_vh,
                "blob[{}] versioned_hash mismatch (block={:?} tx={:?}) — archive may be corrupt",
                i, ab.block_number, ab.tx_index
            );

            println!(
                "  [{}/{}] block={} tx={} vh=0x{}…",
                i + 1,
                total,
                ab.block_number.unwrap_or(0),
                ab.tx_index.unwrap_or(0),
                &ab.blob_versioned_hash[2..10]
            );

            ReaderBatch {
                versioned_hash: l1_vh,
                commitment,
                opening_proof,
                content_tag:  decode_hex32(&ab.content_tag),
                // decoder and sig_registry are not in BatchRow; the circuit
                // asserts both are 0x0 (see Step 0), so we supply zeros.
                decoder:      [0u8; 20],
                sig_registry: [0u8; 20],
                block_number: ab.block_number
                    .expect("confirmed batch must have block_number"),
                tx_index: ab.tx_index
                    .expect("confirmed batch must have tx_index"),
                // startFE / endFE are not stored in BatchRow — default to full
                // blob.  See the known limitation in the module doc comment.
                start_fe: 0,
                end_fe:   4096,
                blob_bytes,
            }
        })
        .collect();

    println!("  Done.\n");

    // ── Step 3: feed to SP1 ───────────────────────────────────────────────────
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

        // Public outputs layout (matches program-reader/src/main.rs):
        //   [0..8]    chain_id (u64 LE)
        //   [8..40]   M (32 bytes)
        //   [40..44]  batch_count (u32 LE)
        //   Per batch (124 bytes): versioned_hash(32) + commitment(48) +
        //                          content_tag(32) + block_number(8 LE) + tx_index(4 LE)
        let raw = output.as_slice();
        let m: [u8; 32] = raw[8..40].try_into().unwrap();
        let pv = parse_public_values(raw);
        print_public_values(&pv);

        let total_cycles = report.total_instruction_count();
        println!("\nCycles: {}", total_cycles);

        if let Some(path) = &args.output {
            let json = serde_json::json!({
                "public_values": pv,
                "cycles": { "total": total },
            });
            std::fs::write(path, serde_json::to_string_pretty(&json).unwrap())
                .unwrap_or_else(|e| eprintln!("Warning: could not write output: {}", e));
            println!("\nResults saved to {}", path);
        }

        // ── Sanity check: recompute M from bam-reader's decoded messages ──────
        println!("\nSanity check: fetching decoded messages from bam-reader…");
        let messages_url = format!(
            "{}/messages?contentTag={}&status=confirmed&limit=1000",
            args.reader_url, args.content_tag
        );
        let msg_resp: MessagesResponse = ureq::get(&messages_url)
            .call()
            .unwrap_or_else(|e| panic!("GET /messages failed: {}", e))
            .into_json()
            .expect("GET /messages: invalid JSON response");

        println!("  {} confirmed message(s) from bam-reader", msg_resp.messages.len());

        let mut reader_messages: Vec<VerifiedMessage> = msg_resp
            .messages
            .iter()
            .map(|api_msg| VerifiedMessage {
                sender: decode_hex20(&api_msg.sender),
                nonce: api_msg.nonce.parse::<u64>().expect("nonce must be a u64 decimal string"),
                contents: decode_hex_bytes(&api_msg.contents),
                block_number: api_msg.block_number.expect("confirmed message must have blockNumber"),
                tx_index: api_msg.tx_index.expect("confirmed message must have txIndex"),
                msg_index: api_msg
                    .message_index_within_batch
                    .expect("confirmed message must have messageIndexWithinBatch"),
            })
            .collect();

        reader_messages.sort_by(|a, b| {
            a.block_number
                .cmp(&b.block_number)
                .then(a.tx_index.cmp(&b.tx_index))
                .then(a.msg_index.cmp(&b.msg_index))
        });

        let m_reader = compute_message_commitment(&reader_messages);

        if m == m_reader {
            println!("  PASS: circuit M == bam-reader M (0x{})", hex::encode(m));
        } else {
            eprintln!("  FAIL: M mismatch!");
            eprintln!("    circuit M:    0x{}", hex::encode(m));
            eprintln!("    bam-reader M: 0x{}", hex::encode(m_reader));
            eprintln!("  Likely causes:");
            eprintln!("    - ZSTD-encoded batches (codec=0x01): bam-reader decodes them, circuit skips them");
            eprintln!("    - Signature verification divergence between circuit and bam-reader");
            std::process::exit(1);
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
