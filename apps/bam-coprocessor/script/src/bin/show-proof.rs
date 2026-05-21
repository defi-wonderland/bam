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
//!
//!   # Run the full BN254 pairing check (same path as the WASM browser verifier):
//!   cargo run --release --bin show-proof -- proof.bin --verify-groth16
//!
//!   # Dump JSON for the browser demo (Groth16 only). Redirect to public/proof.json:
//!   cargo run --release --bin show-proof -- proof.bin --dump-components 2>/dev/null > public/proof.json

use bam_coprocessor_script::{
    parse_app_public_values, parse_public_values, print_app_public_values, print_public_values,
};
use clap::Parser;
use num_bigint::BigUint;
use sp1_sdk::{
    blocking::{Prover, ProverClient},
    include_elf, Elf, ProvingKey, SP1Proof, SP1ProofWithPublicValues,
};
use sp1_verifier::{Groth16Verifier, GROTH16_VK_BYTES};
use std::str::FromStr;

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

    /// Run Groth16Verifier::verify directly (BN254 pairing) — same code path as the WASM browser verifier.
    #[arg(long)]
    verify_groth16: bool,

    /// Dump proof components as JSON for the WASM browser verifier (Groth16 only).
    /// Outputs { proof, public_inputs, vk_hash } to stdout. Redirect to public/proof.json.
    #[arg(long)]
    dump_components: bool,
}

/// Derive the SP1 program VK hash (bytes32 format) from gnark public_inputs[0].
///
/// The gnark circuit stores vk.bytes32() as public_inputs[0] — a BN254 Fr element produced by
/// koalabears_to_bn254(vk.hash_koalabear()). It's stored as a decimal BigUint string.
/// Converting back to "0x{:0>64x}" gives the value expected by Groth16Verifier::verify.
///
/// NOTE: this is NOT the same as vk.hash_u32() serialised as big-endian bytes. hash_u32() returns
/// raw KoalaBear field elements; bytes32() folds them into a single BN254 Fr scalar via
/// koalabears_to_bn254(). The two values look completely different.
fn vk_hash_from_proof(g16_public_input_0: &str) -> String {
    let n = BigUint::from_str(g16_public_input_0)
        .expect("public_inputs[0] is not a valid decimal integer");
    format!("0x{:0>64}", n.to_str_radix(16))
}

fn main() {
    sp1_sdk::utils::setup_logger();
    let args = Args::parse();

    let proof = SP1ProofWithPublicValues::load(&args.proof)
        .expect("failed to load proof — is the path correct?");

    if args.verify_groth16 {
        use sha2::{Digest, Sha256};

        let SP1Proof::Groth16(g16) = &proof.proof else {
            eprintln!("not a Groth16 proof"); std::process::exit(1);
        };

        let vk_hash = vk_hash_from_proof(&g16.public_inputs[0]);
        let proof_bytes = proof.bytes();
        let public_inputs = proof.public_values.to_vec();

        println!("Gnark public inputs (baked into proof struct):");
        for (i, s) in g16.public_inputs.iter().enumerate() {
            println!("  [{}] {}", i, s);
        }

        let sp1_vk_bytes = hex::decode(&vk_hash[2..]).unwrap();
        let mut pi_hash = Sha256::digest(&public_inputs).to_vec();
        pi_hash[0] &= 0x1f;
        println!("\nWhat verify() would compute:");
        println!("  [0] sp1_vkey_hash: {}", hex::encode(&sp1_vk_bytes));
        println!("  [1] sha256(pi)[0]&0x1f: {}", hex::encode(&pi_hash));
        println!("  [2] exit_code (bytes): {}", hex::encode(&proof_bytes[4..36]));
        println!("  [3] vk_root   (bytes): {}", hex::encode(&proof_bytes[36..68]));
        println!("  [4] nonce     (bytes): {}", hex::encode(&proof_bytes[68..100]));

        println!("\nRunning Groth16Verifier::verify (BN254 pairing)…");
        match Groth16Verifier::verify(&proof_bytes, &public_inputs, &vk_hash, &GROTH16_VK_BYTES) {
            Ok(()) => println!("Groth16 pairing: OK ✓"),
            Err(e)  => println!("Groth16 pairing: FAILED — {e:?}"),
        }
        return;
    }

    if args.dump_components {
        let SP1Proof::Groth16(g16) = &proof.proof else {
            eprintln!("Error: --dump-components requires a Groth16 proof (use --proof-type groth16 when proving)");
            std::process::exit(1);
        };
        let vk_hash = vk_hash_from_proof(&g16.public_inputs[0]);
        let json = serde_json::json!({
            "proof": hex::encode(proof.bytes()),
            "public_inputs": hex::encode(proof.public_values.as_slice()),
            "vk_hash": vk_hash,
        });
        println!("{}", serde_json::to_string_pretty(&json).unwrap());
        return;
    }

    println!("Loading proof from {}…", args.proof);
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
