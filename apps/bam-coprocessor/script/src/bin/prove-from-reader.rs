//! Circuit 1 host CLI — reads live blob data from a bam-reader instance and
//! either executes or proves the per-message C1 guest.
//!
//! The user picks a batch by `--tx-hash` (fast, `GET /batches/:txHash`) or
//! by `(--block-number, --tx-index)` (filtered locally). `--msg-index`
//! selects the message inside that batch's wire-format payload.
//!
//! Usage:
//!   cargo run --release --bin prove-from-reader -- \
//!     --execute --content-tag 0xf0fea9… --tx-hash 0x… --msg-index 0
//!
//!   SP1_PROVER=network NETWORK_PRIVATE_KEY=0x<key> \
//!     cargo run --release --bin prove-from-reader -- --prove --content-tag 0xf0fea9… \
//!       --block-number 10932896 --tx-index 7 --msg-index 0

use bam_coprocessor_script::{
    parse_message_public_values,
    pipeline::{fetch_one_batch, BatchSelector},
    print_message_public_values,
    reader_api::ReaderClient,
    sp1_runner::{execute_c1, prove_c1},
};
use clap::Parser;
use sp1_sdk::{include_elf, Elf};

const BAM_READER_ELF: Elf = include_elf!("bam-reader-program");

#[derive(Parser, Debug)]
#[command(about = "BAM reader coprocessor host — reads from a live bam-reader instance")]
struct Args {
    #[arg(long)]
    execute: bool,

    #[arg(long)]
    prove: bool,

    /// Proof format for --prove mode. Defaults to groth16 (the deliverable per REDESIGN.md).
    #[arg(long, default_value = "groth16", value_parser = ["groth16", "compressed"])]
    proof_type: String,

    #[arg(long, default_value = "http://localhost:7777")]
    reader_url: String,

    /// 0x-prefixed bytes32 content tag (only required when selecting by block+tx).
    #[arg(long)]
    content_tag: String,

    #[arg(long, default_value = "1")]
    chain_id: u64,

    /// Pick the batch by L1 transaction hash (preferred; uses GET /batches/:txHash).
    #[arg(long, conflicts_with_all = ["block_number", "tx_index"])]
    tx_hash: Option<String>,

    #[arg(long, requires = "tx_index")]
    block_number: Option<u64>,

    #[arg(long, requires = "block_number")]
    tx_index: Option<u32>,

    /// Which message inside the batch to prove (per-message C1 redesign).
    #[arg(long, default_value = "0")]
    msg_index: u32,

    /// Save output to a file. In --execute mode: JSON with public values + cycle stats.
    /// In --prove mode: serialized SP1 proof (binary, loadable by show-proof).
    #[arg(long)]
    output: Option<String>,
}

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
    if args.tx_hash.is_none() && (args.block_number.is_none() || args.tx_index.is_none()) {
        eprintln!(
            "Error: provide either --tx-hash <bytes32> OR --block-number <u64> + --tx-index <u32>"
        );
        std::process::exit(1);
    }

    println!("BAM reader coprocessor — Circuit 1 (per-message)");
    println!("reader_url:  {}", args.reader_url);
    println!("content_tag: {}", args.content_tag);
    println!("chain_id:    {}", args.chain_id);
    println!("msg_index:   {}", args.msg_index);

    let client = ReaderClient::new(&args.reader_url);
    let selector = match &args.tx_hash {
        Some(tx) => BatchSelector::TxHash(tx),
        None => BatchSelector::ChainCoord {
            content_tag: &args.content_tag,
            block_number: args.block_number.unwrap(),
            tx_index: args.tx_index.unwrap(),
        },
    };

    let (api, batch) = fetch_one_batch(&client, selector, args.chain_id)
        .unwrap_or_else(|e| panic!("fetch_one_batch failed: {e}"));
    println!(
        "  tx={} block={} tx_index={} vh=0x{}…\n",
        &api.tx_hash[..10],
        batch.block_number,
        batch.tx_index,
        &api.blob_versioned_hash[2..10]
    );

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
