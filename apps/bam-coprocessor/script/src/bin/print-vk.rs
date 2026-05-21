//! Print the Circuit 1 verifying key hash.
//!
//! Run this once after any change to program-reader, then paste the output
//! into the verify_sp1_proof call in program-app/src/main.rs.
//!
//! Usage:
//!   cargo run --release --bin print-vk

use sp1_sdk::{
    blocking::{Prover, ProverClient},
    include_elf, Elf, HashableKey, ProvingKey,
};

const BAM_READER_ELF: Elf = include_elf!("bam-reader-program");

fn main() {
    let client = ProverClient::from_env();
    let pk = client.setup(BAM_READER_ELF).expect("setup failed");
    let vk = pk.verifying_key();

    let hash_u32 = vk.hash_u32();
    println!("C1 verifying key hash (u32 x8, for verify_sp1_proof in program-app):");
    println!("{:?}", hash_u32);
    println!();
    println!("Paste into program-app/src/main.rs:");
    println!(
        "    sp1_zkvm::lib::verify::verify_sp1_proof(&{:?}, &[0u8; 32]);",
        hash_u32
    );
    println!();

    let bytes32 = vk.bytes32();
    println!("C1 verifying key hash (bytes32, for Groth16Verifier::verify / WASM demo):");
    println!("{}", bytes32);
}
