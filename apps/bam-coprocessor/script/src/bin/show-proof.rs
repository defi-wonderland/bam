//! Load a saved SP1 proof and display its public values. Optionally verify it.
//!
//! Usage:
//!   # Circuit 1 (default) — display public values:
//!   cargo run --release --bin show-proof -- proof.bin
//!
//!   # Circuit 2 (bam-twitter timeline):
//!   cargo run --release --bin show-proof -- proof.bin --circuit app
//!
//!   # Also verify cryptographically (works for both circuits):
//!   cargo run --release --bin show-proof -- proof.bin --circuit app --verify

use bam_coprocessor_script::{
    parse_app_public_values, parse_public_values, print_app_public_values, print_public_values,
};
use clap::Parser;
use sp1_sdk::{
    blocking::{Prover, ProverClient},
    include_elf, Elf, ProvingKey, SP1ProofWithPublicValues,
};

const BAM_READER_ELF: Elf = include_elf!("bam-reader-program");
const BAM_APP_ELF: Elf = include_elf!("bam-app-program");

#[derive(Parser, Debug)]
#[command(about = "Display and optionally verify a saved BAM coprocessor proof")]
struct Args {
    /// Path to the proof file.
    proof: String,

    /// Which circuit produced this proof.
    #[arg(long, default_value = "reader", value_parser = ["reader", "app"])]
    circuit: String,

    /// Verify the proof cryptographically against the circuit ELF.
    #[arg(long)]
    verify: bool,
}

fn main() {
    sp1_sdk::utils::setup_logger();
    let args = Args::parse();

    println!("Loading proof from {}…", args.proof);
    let proof = SP1ProofWithPublicValues::load(&args.proof)
        .expect("failed to load proof — is the path correct?");

    println!("SP1 version: {}\n", proof.sp1_version);

    let raw = proof.public_values.as_slice();

    match args.circuit.as_str() {
        "reader" => {
            let pv = parse_public_values(raw);
            print_public_values(&pv);

            if args.verify {
                println!("\nVerifying Circuit 1 proof…");
                let client = ProverClient::from_env();
                let pk = client.setup(BAM_READER_ELF).expect("ELF setup failed");
                client
                    .verify(&proof, pk.verifying_key(), None)
                    .expect("proof verification failed");
                println!("Proof verified!");
            } else {
                println!("\n(run with --verify to cryptographically verify the proof)");
            }
        }
        "app" => {
            let pv = parse_app_public_values(raw);
            print_app_public_values(&pv);

            if args.verify {
                println!("\nVerifying Circuit 2 proof…");
                let client = ProverClient::from_env();
                let pk = client.setup(BAM_APP_ELF).expect("ELF setup failed");
                client
                    .verify(&proof, pk.verifying_key(), None)
                    .expect("proof verification failed");
                println!("Proof verified!");
            } else {
                println!("\n(run with --verify to cryptographically verify the proof)");
            }
        }
        _ => unreachable!("value_parser constrains circuit to 'reader' or 'app'"),
    }
}
