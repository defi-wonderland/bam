//! SP1 driver wrappers: execute or prove the per-message C1 guest against
//! a single `BlobInput`.
//!
//! Bin callers stay on `ProverClient::from_env()` (blocking). The service
//! crate uses the lower-level `network::NetworkClient` directly so it can
//! capture `request_id` synchronously before awaiting the proof — required
//! for crash-recovery via `coprocessor.proof_in_flight`.

use bam_coprocessor_lib::BlobInput;
use sp1_sdk::{
    blocking::{ProveRequest, Prover, ProverClient},
    Elf, SP1ProofWithPublicValues, SP1Stdin,
};

/// Stdin layout for the per-message C1 guest.
pub fn build_stdin(chain_id: u64, batch: &BlobInput, msg_index: u32) -> SP1Stdin {
    let mut stdin = SP1Stdin::new();
    stdin.write(&chain_id);
    stdin.write(batch);
    stdin.write(&msg_index);
    stdin
}

pub struct ExecuteOutput {
    pub public_values: Vec<u8>,
    pub total_cycles: u64,
}

/// Run the guest in execute mode (no proof). Returns raw public-values
/// bytes (152 B) + total cycle count.
pub fn execute_c1(
    elf: Elf,
    chain_id: u64,
    batch: &BlobInput,
    msg_index: u32,
) -> Result<ExecuteOutput, String> {
    let stdin = build_stdin(chain_id, batch, msg_index);
    let client = ProverClient::from_env();
    let (output, report) = client
        .execute(elf, stdin)
        .run()
        .map_err(|e| format!("execute failed: {e}"))?;
    Ok(ExecuteOutput {
        public_values: output.as_slice().to_vec(),
        total_cycles: report.total_instruction_count(),
    })
}

/// Run the guest in prove mode against whichever prover `SP1_PROVER`
/// selects (`network` for Succinct, `mock` for fast non-cryptographic
/// proofs). Picks Groth16 when `groth16` is true, compressed STARK
/// otherwise. Returns a serialisable proof bundle (load via
/// `SP1ProofWithPublicValues::load`).
///
/// Bin paths use this. The service crate replaces this with a direct
/// `network::NetworkClient` invocation so it can persist `request_id`
/// before awaiting the result.
pub fn prove_c1(
    elf: Elf,
    chain_id: u64,
    batch: &BlobInput,
    msg_index: u32,
    groth16: bool,
) -> Result<SP1ProofWithPublicValues, String> {
    let stdin = build_stdin(chain_id, batch, msg_index);
    let client = ProverClient::from_env();
    let pk = client.setup(elf).map_err(|e| format!("setup failed: {e}"))?;
    let req = client.prove(&pk, stdin);
    let proof = if groth16 {
        req.groth16().run().map_err(|e| format!("groth16 prove failed: {e}"))?
    } else {
        req.compressed().run().map_err(|e| format!("compressed prove failed: {e}"))?
    };
    Ok(proof)
}
