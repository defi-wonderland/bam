//! BLS12-381 pairing benchmark host.
//!
//! Runs the benchmark guest in execute mode (no proof) and prints the cycle
//! count alongside a Phase 4 cost projection.
//!
//! Usage:
//!   cargo run --release --bin benchmark

use sp1_sdk::{
    blocking::{Prover, ProverClient},
    include_elf, Elf, SP1Stdin,
};

const BENCHMARK_ELF: Elf = include_elf!("bam-twitter-benchmark");

// Cycle count from Phase 2 (sha256 binding over 9 × 131KB blobs).
const PHASE2_CYCLES: u64 = 89_000_000;
// Number of KZG pairings per blob opening check.
const PAIRINGS_PER_BLOB: u64 = 2;
// Number of blobs in the current test dataset.
const BLOB_COUNT: u64 = 9;

fn main() {
    sp1_sdk::utils::setup_logger();

    println!("BLS12-381 pairing benchmark — SP1 v6");
    println!("Guest: 2 pairings (= 1 KZG opening verification)");
    println!();
    println!("SP1 v6 precompile status for BLS12-381:");
    println!("  G1 add:    ✓ precompile");
    println!("  G1 double: ✓ precompile");
    println!("  Pairing:   ✗ pure software (Miller loop + Fp12 final exp)");
    println!();

    let client = ProverClient::from_env();
    let stdin = SP1Stdin::new();

    let (_, report) = client
        .execute(BENCHMARK_ELF, stdin)
        .run()
        .expect("benchmark execution failed");

    let total_cycles = report.total_instruction_count();
    let per_pairing = total_cycles / PAIRINGS_PER_BLOB;

    println!("─── Results ──────────────────────────────────────────────");
    println!("  2 pairings (guest total):  {:>14} cycles", total_cycles);
    println!("  Per pairing (estimated):   {:>14} cycles", per_pairing);
    println!();

    let kzg_per_blob = PAIRINGS_PER_BLOB * per_pairing;
    let kzg_total = BLOB_COUNT * kzg_per_blob;
    let phase4_estimate = PHASE2_CYCLES + kzg_total;

    println!("─── Phase 4 projection ({} blobs, {} pairings/blob) ────────", BLOB_COUNT, PAIRINGS_PER_BLOB);
    println!("  KZG overhead per blob:     {:>14} cycles", kzg_per_blob);
    println!("  KZG overhead total:        {:>14} cycles", kzg_total);
    println!("  Phase 2 baseline:          {:>14} cycles  (sha256 binding)", PHASE2_CYCLES);
    println!("  Phase 4 estimate:          {:>14} cycles", phase4_estimate);
    println!();

    println!("─── Verdict ──────────────────────────────────────────────");
    if phase4_estimate < 300_000_000 {
        println!("  → kzg-inside (KZG inside zkVM) looks cheap. Go for it.");
    } else if phase4_estimate < 1_000_000_000 {
        println!("  → kzg-inside feasible but not cheap. Benchmark on a GPU before committing.");
    } else if phase4_estimate < 5_000_000_000 {
        println!("  → kzg-inside expensive (~{}B cycles). Consider kzg-outside (external KZG).", phase4_estimate / 1_000_000_000);
        println!("    Or wait for a native SP1 pairing precompile.");
    } else {
        println!("  → kzg-inside prohibitive ({}B cycles). Use kzg-outside.", phase4_estimate / 1_000_000_000);
        println!("    External KZG verification feeding certified field elements into the zkVM.");
    }
}
