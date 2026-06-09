//! `GET /validation/latest` — paginated list of recently validated messages.

use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::queries::{self, ValidationRow};
use crate::http::json::{
    b64, bad_request, decode_cursor, encode_cursor, hex_prefixed, service_unavailable,
};
use crate::state::AppState;

const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 200;

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub limit: Option<i64>,
    pub cursor: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ValidationListResponse {
    pub items: Vec<MessageValidationEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageValidationEntry {
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
    pub validated_at: String,
}

pub async fn handler(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ListQuery>,
) -> Result<Json<ValidationListResponse>, (StatusCode, Json<Value>)> {
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
    let cursor_was_present = cursor.is_some();
    let rows = queries::list_validations_page(&state.pg, chain_id, cursor, limit)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "list_validations_page failed");
            crate::http::json::internal_error()
        })?;

    // 503 only when there are NO validations at all (i.e. caller didn't
    // page past the end). With a cursor, an empty page is the
    // end-of-list signal, not an outage.
    if rows.is_empty() && !cursor_was_present {
        return Err(service_unavailable("no_validation_yet"));
    }

    let next_cursor = if rows.len() as i64 == limit {
        rows.last()
            .map(|r| encode_cursor(r.validated_at, &r.message_hash))
    } else {
        None
    };

    Ok(Json(ValidationListResponse {
        items: rows.into_iter().map(into_entry).collect(),
        next_cursor,
    }))
}

fn into_entry(r: ValidationRow) -> MessageValidationEntry {
    MessageValidationEntry {
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
        validated_at: r.validated_at.to_rfc3339(),
    }
}

// Silence unused-import warning for `b64` if it stays unused here long-term.
#[allow(dead_code)]
fn _b64(b: &[u8]) -> String {
    b64(b)
}

#[allow(dead_code)]
fn _io() -> impl IntoResponse {
    StatusCode::NOT_IMPLEMENTED
}
