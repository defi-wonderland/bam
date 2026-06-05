//! Shared HTTP helpers: hex/base64 encoding for the per-message API shapes,
//! cursor encoding for keyset pagination, JSON error responses.

use axum::{http::StatusCode, Json};
use base64::{
    engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD as BASE64_URL},
    Engine,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub fn hex_prefixed(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

pub fn b64(bytes: &[u8]) -> String {
    BASE64.encode(bytes)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Cursor {
    pub at: DateTime<Utc>,
    pub message_hash: String,
}

pub fn encode_cursor(at: DateTime<Utc>, message_hash: &[u8]) -> String {
    // URL-safe + no-pad — cursors are carried in query strings, where `+`
    // is silently decoded as space.
    let c = Cursor {
        at,
        message_hash: hex_prefixed(message_hash),
    };
    BASE64_URL.encode(serde_json::to_vec(&c).unwrap())
}

pub fn decode_cursor(raw: &str) -> Option<(DateTime<Utc>, Vec<u8>)> {
    let bytes = BASE64_URL.decode(raw).ok()?;
    let c: Cursor = serde_json::from_slice(&bytes).ok()?;
    let hash = c.message_hash.strip_prefix("0x").unwrap_or(&c.message_hash);
    let hash = hex::decode(hash).ok()?;
    Some((c.at, hash))
}

pub fn json_error(status: StatusCode, error: &str, reason: Option<&str>) -> (StatusCode, Json<Value>) {
    let body = match reason {
        Some(r) => json!({ "error": error, "reason": r }),
        None => json!({ "error": error }),
    };
    (status, Json(body))
}

pub fn bad_request(reason: &str) -> (StatusCode, Json<Value>) {
    json_error(StatusCode::BAD_REQUEST, "bad_request", Some(reason))
}

pub fn not_found() -> (StatusCode, Json<Value>) {
    json_error(StatusCode::NOT_FOUND, "not_found", None)
}

pub fn service_unavailable(reason: &str) -> (StatusCode, Json<Value>) {
    json_error(StatusCode::SERVICE_UNAVAILABLE, reason, None)
}

pub fn internal_error() -> (StatusCode, Json<Value>) {
    json_error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", None)
}

pub fn is_lowercase_bytes32_hex(s: &str) -> bool {
    if !s.starts_with("0x") || s.len() != 66 {
        return false;
    }
    s[2..].chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}
