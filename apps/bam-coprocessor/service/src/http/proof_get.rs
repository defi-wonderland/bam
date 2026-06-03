//! `GET /proof/:message_hash` and `GET /proof/by-blob/:versioned_hash`.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::Serialize;
use serde_json::Value;

use crate::db::queries::{self, ProofFullRow};
use crate::http::json::{
    b64, bad_request, hex_prefixed, internal_error, is_lowercase_bytes32_hex, not_found,
};
use crate::http::proof_list::{summary_to_entry, MessageProofEntry};
use crate::state::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageProofBundle {
    pub message_hash: String,
    pub chain_id: i64,
    pub versioned_hash: String,
    pub content_tag: String,
    pub start_fe: i32,
    pub end_fe: i32,
    pub block_number: i64,
    pub tx_index: i32,
    pub msg_index: i32,
    pub sender: String,
    pub nonce: String,
    pub cycles: i64,
    pub proof_size: i32,
    pub proof_bytes: String,
    pub public_values: String,
    pub vk_url: &'static str,
    pub request_id: String,
    pub tx_hash: Option<String>,
    pub proof_type: String,
    pub sp1_version: String,
    pub proven_at: String,
}

pub async fn by_message_hash(
    State(state): State<Arc<AppState>>,
    Path(message_hash): Path<String>,
) -> Result<Json<MessageProofBundle>, (StatusCode, Json<Value>)> {
    let mh = normalise_hash(&message_hash).ok_or_else(|| bad_request("messageHash"))?;
    let row = queries::get_proof_by_hash(&state.pg, &mh)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "get_proof_by_hash failed");
            internal_error()
        })?;
    match row {
        Some(r) => Ok(Json(full_to_bundle(r))),
        None => Err(not_found()),
    }
}

pub async fn by_versioned_hash(
    State(state): State<Arc<AppState>>,
    Path(versioned_hash): Path<String>,
) -> Result<Json<ByBlobResponse>, (StatusCode, Json<Value>)> {
    let vh = normalise_hash(&versioned_hash).ok_or_else(|| bad_request("versionedHash"))?;
    let rows = queries::get_proofs_by_versioned_hash(&state.pg, &vh)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "get_proofs_by_versioned_hash failed");
            internal_error()
        })?;
    Ok(Json(ByBlobResponse {
        items: rows.into_iter().map(summary_to_entry).collect(),
    }))
}

#[derive(Debug, Serialize)]
pub struct ByBlobResponse {
    pub items: Vec<MessageProofEntry>,
}

fn normalise_hash(input: &str) -> Option<Vec<u8>> {
    let lower = input.to_ascii_lowercase();
    if !is_lowercase_bytes32_hex(&lower) {
        return None;
    }
    hex::decode(&lower[2..]).ok()
}

fn full_to_bundle(r: ProofFullRow) -> MessageProofBundle {
    MessageProofBundle {
        message_hash: hex_prefixed(&r.message_hash),
        chain_id: r.chain_id,
        versioned_hash: hex_prefixed(&r.versioned_hash),
        content_tag: hex_prefixed(&r.content_tag),
        start_fe: r.start_fe,
        end_fe: r.end_fe,
        block_number: r.block_number,
        tx_index: r.tx_index,
        msg_index: r.msg_index,
        sender: hex_prefixed(&r.sender),
        nonce: r.nonce.to_string(),
        cycles: r.cycles,
        proof_size: r.proof_size,
        proof_bytes: b64(&r.proof_bytes),
        public_values: b64(&r.public_values),
        vk_url: "/proof/vk",
        request_id: hex_prefixed(&r.request_id),
        tx_hash: r.tx_hash.as_deref().map(hex_prefixed),
        proof_type: r.proof_type,
        sp1_version: r.sp1_version,
        proven_at: r.proven_at.to_rfc3339(),
    }
}
