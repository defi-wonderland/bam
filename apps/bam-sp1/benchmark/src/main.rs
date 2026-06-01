//! BLS12-381 pairing benchmark for SP1.
//!
//! Measures the cycle cost of BLS12-381 pairing inside the SP1 zkVM.
//! This is the critical benchmark for Phase 4 (KZG binding).
//!
//! A KZG opening verification requires exactly 2 pairings:
//!   e(C - [y]₁, [1]₂) == e(π, [τ - z]₂)
//!
//! SP1 v6 has precompiles for BLS12-381 G1 add and G1 double, but NO native
//! pairing precompile. The Miller loop and final exponentiation over Fp12 run
//! in pure software on the riscv64im target.
//!
//! The host (script/src/bin/benchmark.rs) reads the cycle count and prints
//! a Phase 4 cost projection against the 89M-cycle Phase 2 baseline.

#![no_main]
sp1_zkvm::entrypoint!(main);

use bls12_381::{pairing, G1Affine, G2Affine};

pub fn main() {
    let g1 = G1Affine::generator();
    let g2 = G2Affine::generator();

    // Two pairings — the exact cost of one KZG opening check.
    // We use the generator points as stand-ins; pairing cost is independent
    // of the specific point values (it is not a constant-time shortcut).
    let lhs = pairing(&g1, &g2);
    let rhs = pairing(&g1, &g2);

    // Commit one byte so the zkVM has a well-formed output.
    // The equality is always true here; what matters is the cycle count.
    sp1_zkvm::io::commit_slice(&[u8::from(lhs == rhs)]);
}
