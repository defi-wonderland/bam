//! `GET /proof` — paginated list of Groth16 proof summaries.

use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::queries::{self, ProofSummaryRow};
use crate::http::json::{bad_request, decode_cursor, encode_cursor, hex_prefixed, internal_error};
use crate::state::AppState;

const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 200;

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub limit: Option<i64>,
    pub cursor: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ProofListResponse {
    pub items: Vec<MessageProofEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageProofEntry {
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
    pub proof_type: String,
    pub request_id: String,
    pub tx_hash: Option<String>,
    pub sp1_version: String,
    pub proven_at: String,
}

pub async fn handler(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ListQuery>,
) -> Result<Json<ProofListResponse>, (StatusCode, Json<Value>)> {
    let limit = q.limit.unwrap_or(DEFAULT_LIMIT);
    if !(1..=MAX_LIMIT).contains(&limit) {
        return Err(bad_request("limit"));
    }
    let cursor = match q.cursor {
        Some(c) => match decode_cursor(&c) {
            Some(parsed) => Some(parsed),
            None => return Err(bad_request("cursor")),
        },
        None => None,
    };

    let chain_id = state.config.chain_id as i64;
    let rows = queries::list_proofs_page(&state.pg, chain_id, cursor, limit)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "list_proofs_page failed");
            internal_error()
        })?;

    let next_cursor = if rows.len() as i64 == limit {
        rows.last().map(|r| encode_cursor(r.proven_at, &r.message_hash))
    } else {
        None
    };

    Ok(Json(ProofListResponse {
        items: rows.into_iter().map(summary_to_entry).collect(),
        next_cursor,
    }))
}

pub(crate) fn summary_to_entry(r: ProofSummaryRow) -> MessageProofEntry {
    MessageProofEntry {
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
        proof_type: r.proof_type,
        request_id: hex_prefixed(&r.request_id),
        tx_hash: r.tx_hash.as_deref().map(hex_prefixed),
        sp1_version: r.sp1_version,
        proven_at: r.proven_at.to_rfc3339(),
    }
}
