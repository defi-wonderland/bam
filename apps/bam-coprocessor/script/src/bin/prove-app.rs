//! Circuit 2 host script — BAM twitter coprocessor.
//!
//! Loads Circuit 1's execute output (results.json), fetches confirmed messages
//! from a bam-reader instance, filters to only the messages covered by the C1
//! batch manifest, and runs the Circuit 2 guest (bam-twitter filter + dedup +
//! timeline root R).
//!
//! chain_id is read from the C1 output — no need to supply it separately.
//!
//! Usage (execute mode — no proof hardware needed):
//!   cargo run --release --bin prove-app -- \
//!     --execute \
//!     --c1-output results.json \
//!     --reader-url https://bam-reader.fly.dev
//!
//! Usage (prove mode — Succinct network):
//!   NOTE: Circuit 1 must have been proved with .compressed() first.
//!         See CIRCUIT2.md § "Compressed proof" for the full sequence.
//!         Replace [0u32; 8] in verify_sp1_proof (program-app/src/main.rs) with
//!         pk1.verifying_key().hash_u32() before the recursive proof is sound.
//!   SP1_PROVER=network SP1_PRIVATE_KEY=<key> \
//!   cargo run --release --bin prove-app -- \
//!     --prove \
//!     --c1-proof c1_proof.bin \
//!     --reader-url https://bam-reader.fly.dev

use bam_coprocessor_lib::{compute_message_commitment, VerifiedMessage};
use bam_coprocessor_script::{parse_app_public_values, parse_public_values, print_app_public_values};
use clap::Parser;
use serde::Deserialize;
use sp1_sdk::{
    blocking::{ProveRequest, Prover, ProverClient},
    include_elf, Elf, ProvingKey, SP1Proof, SP1ProofWithPublicValues, SP1Stdin,
};
use std::collections::HashSet;

const BAM_APP_ELF: Elf = include_elf!("bam-app-program");

// ── CLI ───────────────────────────────────────────────────────────────────────

#[derive(Parser, Debug)]
#[command(about = "BAM twitter coprocessor host (Circuit 2)")]
struct Args {
    #[arg(long)]
    execute: bool,

    #[arg(long)]
    prove: bool,

    /// Path to Circuit 1 results.json (execute mode).
    #[arg(long)]
    c1_output: Option<String>,

    /// Path to Circuit 1 compressed proof .bin (prove mode).
    #[arg(long)]
    c1_proof: Option<String>,

    #[arg(long, default_value = "https://bam-reader.fly.dev")]
    reader_url: String,

    /// Content tag to filter messages (default: bam-twitter).
    #[arg(long, default_value = "0xf0fea94ffd2ae32ed878c57e3427bbffab46d333d09837bc640d952795090718")]
    content_tag: String,

    #[arg(long)]
    output: Option<String>,
}

// ── Deserialization ───────────────────────────────────────────────────────────

/// Subset of Circuit 1 results.json we need.
#[derive(Deserialize)]
struct C1Results {
    public_values: C1PublicValues,
}

#[derive(Deserialize)]
struct C1PublicValues {
    chain_id: u64,
    message_commitment: String,
    batches: Vec<C1BatchMeta>,
}

#[derive(Deserialize)]
struct C1BatchMeta {
    block_number: u64,
    tx_index: u32,
}

/// One entry from `GET /messages`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiMessage {
    sender: String,
    nonce: String, // bigint → JSON string
    contents: String,
    block_number: Option<u64>,
    tx_index: Option<u32>,
    message_index_within_batch: Option<u32>,
}

#[derive(Deserialize)]
struct MessagesResponse {
    messages: Vec<ApiMessage>,
}

// ── Hex helpers ───────────────────────────────────────────────────────────────

fn decode_hex20(s: &str) -> [u8; 20] {
    let s = s.strip_prefix("0x").unwrap_or(s);
    hex::decode(s).expect("invalid hex").try_into().expect("expected 20 bytes")
}

fn decode_hex_bytes(s: &str) -> Vec<u8> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    hex::decode(s).expect("invalid hex")
}

fn decode_hex32(s: &str) -> [u8; 32] {
    let s = s.strip_prefix("0x").unwrap_or(s);
    hex::decode(s).expect("invalid hex").try_into().expect("expected 32 bytes")
}

// ── Message fetch + filter ────────────────────────────────────────────────────

fn fetch_messages(reader_url: &str, content_tag: &str) -> Vec<ApiMessage> {
    let url = format!("{}/messages?contentTag={}&status=confirmed", reader_url, content_tag);
    println!("Fetching messages from {}…", url);
    let resp: MessagesResponse = ureq::get(&url)
        .timeout(std::time::Duration::from_secs(15))
        .call()
        .expect("GET /messages failed")
        .into_json()
        .expect("invalid JSON from /messages");
    println!("  Got {} confirmed messages", resp.messages.len());
    resp.messages
}

/// Convert ApiMessage → VerifiedMessage and filter to only those present in the
/// C1 batch manifest (by blockNumber, txIndex). Sorts by canonical chain order.
fn filter_and_convert(
    api_msgs: Vec<ApiMessage>,
    c1_batches: &[C1BatchMeta],
) -> Vec<VerifiedMessage> {
    let batch_set: HashSet<(u64, u32)> =
        c1_batches.iter().map(|b| (b.block_number, b.tx_index)).collect();

    let mut messages: Vec<VerifiedMessage> = api_msgs
        .into_iter()
        .filter(|api_msg| {
            let bn = api_msg.block_number.unwrap_or(u64::MAX);
            let ti = api_msg.tx_index.unwrap_or(u32::MAX);
            batch_set.contains(&(bn, ti))
        })
        .map(|api_msg| VerifiedMessage {
            sender: decode_hex20(&api_msg.sender),
            nonce: api_msg.nonce.parse::<u64>().expect("nonce is not a valid u64"),
            contents: decode_hex_bytes(&api_msg.contents),
            block_number: api_msg.block_number.expect("confirmed message must have blockNumber"),
            tx_index: api_msg.tx_index.expect("confirmed message must have txIndex"),
            msg_index: api_msg.message_index_within_batch.expect("confirmed message must have messageIndexWithinBatch"),
        })
        .collect();

    messages.sort_by(|a, b| {
        a.block_number
            .cmp(&b.block_number)
            .then(a.tx_index.cmp(&b.tx_index))
            .then(a.msg_index.cmp(&b.msg_index))
    });

    messages
}

/// Build the minimal c1_public_values bytes needed by the Circuit 2 guest
/// from a C1 results.json in execute mode.
///
/// The guest only reads [0..8] (chain_id) and [8..40] (M) from this slice.
/// batch_count is appended for completeness so the format matches the real layout.
fn build_c1_public_values(chain_id: u64, m_hex: &str, batch_count: usize) -> Vec<u8> {
    let m = decode_hex32(m_hex);
    let mut bytes = Vec::with_capacity(44);
    bytes.extend_from_slice(&chain_id.to_le_bytes());
    bytes.extend_from_slice(&m);
    bytes.extend_from_slice(&(batch_count as u32).to_le_bytes());
    bytes
}

// ── Main ──────────────────────────────────────────────────────────────────────

fn main() {
    sp1_sdk::utils::setup_logger();

    let args = Args::parse();
    if args.execute == args.prove {
        eprintln!("Error: specify exactly one of --execute or --prove");
        std::process::exit(1);
    }

    let client = ProverClient::from_env();

    if args.execute {
        let c1_path = args.c1_output.as_deref().unwrap_or("results.json");
        let json = std::fs::read_to_string(c1_path)
            .unwrap_or_else(|_| panic!("C1 results not found at {}. Run prove-reader --execute --output results.json first.", c1_path));
        let c1: C1Results = serde_json::from_str(&json).expect("invalid C1 results JSON");
        let chain_id = c1.public_values.chain_id;

        println!("BAM twitter coprocessor — Circuit 2 (execute mode)");
        println!("chain_id = {}", chain_id);
        println!("C1 M     = {}", c1.public_values.message_commitment);
        println!("C1 batches covered: {}", c1.public_values.batches.len());

        let c1_pv_bytes = build_c1_public_values(
            chain_id,
            &c1.public_values.message_commitment,
            c1.public_values.batches.len(),
        );

        let api_msgs = fetch_messages(&args.reader_url, &args.content_tag);
        let messages = filter_and_convert(api_msgs, &c1.public_values.batches);
        println!("  Messages in C1 scope: {}", messages.len());

        // Sanity check: recompute M from filtered messages and compare to C1's M.
        let recomputed_m = compute_message_commitment(&messages);
        let c1_m = decode_hex32(&c1.public_values.message_commitment);
        if recomputed_m != c1_m {
            eprintln!(
                "ERROR: recomputed M does not match C1 M.\n\
                 C1 M:        0x{}\n\
                 Recomputed:  0x{}\n\
                 This means the messages from /messages do not match what Circuit 1 proved.",
                hex::encode(c1_m),
                hex::encode(recomputed_m),
            );
            std::process::exit(1);
        }
        println!("  M sanity check passed ✓\n");

        let mut stdin = SP1Stdin::new();
        stdin.write(&chain_id);
        stdin.write(&c1_pv_bytes);
        stdin.write(&messages);

        let (output, report) = client
            .execute(BAM_APP_ELF, stdin)
            .run()
            .expect("Circuit 2 execution failed");

        let pv = parse_app_public_values(output.as_slice());
        print_app_public_values(&pv);
        println!("\nCycles: {}", report.total_instruction_count());

        if let Some(path) = &args.output {
            let json = serde_json::json!({ "public_values": pv });
            std::fs::write(path, serde_json::to_string_pretty(&json).unwrap())
                .unwrap_or_else(|e| eprintln!("Warning: could not write output: {}", e));
            println!("Results saved to {}", path);
        }
    } else {
        // Prove mode
        let c1_proof_path = args.c1_proof.as_deref().unwrap_or("c1_proof.bin");
        println!("Loading C1 compressed proof from {}…", c1_proof_path);
        let c1_proof = SP1ProofWithPublicValues::load(c1_proof_path)
            .unwrap_or_else(|_| panic!("Could not load C1 proof from {}", c1_proof_path));

        let c1_pv_bytes = c1_proof.public_values.as_slice().to_vec();

        // Parse chain_id and batch manifest from C1 public values so we can filter messages
        // to exactly the scope C1 proved, mirroring what execute mode does.
        let c1_pv = parse_public_values(&c1_pv_bytes);
        let chain_id = c1_pv.chain_id;

        println!("BAM twitter coprocessor — Circuit 2 (prove mode)");
        println!("chain_id = {}", chain_id);
        println!("C1 M     = {}", c1_pv.message_commitment);
        println!("C1 batches covered: {}", c1_pv.batches.len());

        let c1_batches: Vec<C1BatchMeta> = c1_pv.batches.iter()
            .map(|b| C1BatchMeta { block_number: b.block_number, tx_index: b.tx_index })
            .collect();
        let api_msgs = fetch_messages(&args.reader_url, &args.content_tag);
        let messages = filter_and_convert(api_msgs, &c1_batches);
        println!("  Messages in C1 scope: {}", messages.len());

        // Sanity check M before sending to prover.
        let recomputed_m = compute_message_commitment(&messages);
        let c1_m = decode_hex32(&c1_pv.message_commitment);
        if recomputed_m != c1_m {
            eprintln!(
                "ERROR: recomputed M does not match C1 M.\n\
                 C1 M:        0x{}\n\
                 Recomputed:  0x{}\n\
                 This means the messages from /messages do not match what Circuit 1 proved.",
                hex::encode(c1_m),
                hex::encode(recomputed_m),
            );
            std::process::exit(1);
        }
        println!("  M sanity check passed ✓\n");

        // Setup Circuit 2
        let pk2 = client.setup(BAM_APP_ELF).expect("Circuit 2 setup failed");

        // For recursive verification we also need C1's VK (to supply to write_proof).
        // See CIRCUIT2.md § "VK management".
        let pk1 = client
            .setup(include_elf!("bam-reader-program"))
            .expect("Circuit 1 setup failed");

        // Extract the inner compressed proof (SP1Proof::Compressed holds it boxed).
        let compressed_proof = match c1_proof.proof {
            SP1Proof::Compressed(inner) => *inner,
            _ => panic!("C1 proof must be a Compressed proof — re-run prove-reader with .compressed()"),
        };

        let mut stdin = SP1Stdin::new();
        // write_proof must come before other reads — SP1 processes these in order.
        stdin.write_proof(compressed_proof, pk1.verifying_key().vk.clone());
        stdin.write(&chain_id);
        stdin.write(&c1_pv_bytes);
        stdin.write(&messages);

        println!("Proving Circuit 2…");
        println!("NOTE: SP1_PROVER=network required for remote proving.");

        let proof = client.prove(&pk2, stdin).run().expect("Circuit 2 prove failed");
        println!("Proof generated!");

        let is_mock = std::env::var("SP1_PROVER").unwrap_or_default() == "mock";
        if !is_mock {
            client.verify(&proof, pk2.verifying_key(), None).expect("Circuit 2 verify failed");
            println!("Proof verified!");
        }

        if let Some(path) = &args.output {
            proof.save(path).unwrap_or_else(|e| eprintln!("Warning: could not save: {}", e));
            println!("Proof saved to {}", path);
        }
    }
}
