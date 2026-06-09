//! Boot-time recovery hook.
//!
//! v1 is a no-op: the blocking `prove_c1` wrapper used by Job P does not
//! surface `request_id` synchronously, so we never populate
//! `coprocessor.proof_in_flight`. The table sits empty in v1. When the
//! follow-up switches Job P to the lower-level `NetworkClient`, this
//! hook will scan in-flight rows and reconcile each `request_id` against
//! the Succinct network.

use std::sync::Arc;

use crate::state::AppState;

pub async fn recover_in_flight_proofs(_state: Arc<AppState>) -> anyhow::Result<()> {
    Ok(())
}
