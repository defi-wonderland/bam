//! `GET /proof/vk` — SP1 WASM-verifier format VK bundle, cached on first
//! successful proof.

use std::sync::Arc;

use axum::{extract::State, http::StatusCode, Json};
use serde::Serialize;
use serde_json::Value;

use crate::db::queries;
use crate::http::json::{hex_prefixed, internal_error, service_unavailable};
use crate::state::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VkResponse {
    pub vk_hash: String,
    pub groth16_vk_bytes: String,
    pub sp1_version: String,
    pub captured_at: String,
}

pub async fn handler(
    State(state): State<Arc<AppState>>,
) -> Result<Json<VkResponse>, (StatusCode, Json<Value>)> {
    let row = queries::get_vk(&state.pg).await.map_err(|e| {
        tracing::error!(error = %e, "get_vk failed");
        internal_error()
    })?;
    match row {
        Some(r) => Ok(Json(VkResponse {
            vk_hash: r.vk_hash,
            groth16_vk_bytes: hex_prefixed(&r.groth16_vk),
            sp1_version: r.sp1_version,
            captured_at: r.captured_at.to_rfc3339(),
        })),
        None => Err(service_unavailable("vk_not_ready")),
    }
}
