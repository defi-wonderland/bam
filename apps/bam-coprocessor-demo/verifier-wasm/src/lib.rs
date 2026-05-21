use wasm_bindgen::prelude::*;
use sp1_verifier::{Groth16Verifier, GROTH16_VK_BYTES};

/// Returns empty string on success, error description on failure.
#[wasm_bindgen]
pub fn verify_groth16(proof: &[u8], public_inputs: &[u8], vk_hash: &str) -> String {
    match Groth16Verifier::verify(proof, public_inputs, vk_hash, &GROTH16_VK_BYTES) {
        Ok(()) => String::new(),
        Err(e) => format!("{e:?}"),
    }
}
