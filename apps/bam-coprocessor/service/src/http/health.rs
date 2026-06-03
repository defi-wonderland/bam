//! `GET /health` — observation surface for ops + the fly health check.

use std::sync::Arc;

use axum::{extract::State, Json};
use serde::Serialize;

use crate::db::queries;
use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub healthy: bool,
    pub validation: JobHealth,
    pub proof: ProofHealth,
    /// `null` when the Succinct balance check is disabled or unavailable.
    pub balance_prve: Option<f64>,
    pub paused: bool,
}

#[derive(Debug, Serialize)]
pub struct JobHealth {
    pub last_at: Option<String>,
    pub watermark: Option<WatermarkCoord>,
    pub message_count: i64,
}

#[derive(Debug, Serialize)]
pub struct ProofHealth {
    pub last_at: Option<String>,
    pub last_message_hash: Option<String>,
    pub watermark: Option<WatermarkCoord>,
    pub message_count: i64,
    pub in_flight_count: i64,
}

#[derive(Debug, Serialize)]
pub struct WatermarkCoord {
    pub block_number: i64,
    pub tx_index: i32,
    pub msg_index: i32,
}

pub async fn handler(State(state): State<Arc<AppState>>) -> Json<HealthResponse> {
    let chain_id = state.config.chain_id as i64;
    let pool = &state.pg;

    let v_wm = queries::read_watermark(pool, "validation", chain_id).await.ok();
    let p_wm = queries::read_watermark(pool, "proof", chain_id).await.ok();
    let v_count = queries::validations_count(pool, chain_id).await.unwrap_or(0);
    let p_count = queries::proof_count(pool, chain_id).await.unwrap_or(0);
    let v_at = queries::last_validation_at(pool, chain_id).await.unwrap_or(None);
    let last_p = queries::last_proof(pool, chain_id).await.unwrap_or(None);
    let in_flight = queries::in_flight_count(pool).await.unwrap_or(0);

    Json(HealthResponse {
        healthy: true,
        validation: JobHealth {
            last_at: v_at.map(|t| t.to_rfc3339()),
            watermark: v_wm.map(|w| WatermarkCoord {
                block_number: w.block_number,
                tx_index: w.tx_index,
                msg_index: w.msg_index,
            }),
            message_count: v_count,
        },
        proof: ProofHealth {
            last_at: last_p.as_ref().map(|(t, _)| t.to_rfc3339()),
            last_message_hash: last_p
                .as_ref()
                .map(|(_, h)| crate::http::json::hex_prefixed(h)),
            watermark: p_wm.map(|w| WatermarkCoord {
                block_number: w.block_number,
                tx_index: w.tx_index,
                msg_index: w.msg_index,
            }),
            message_count: p_count,
            in_flight_count: in_flight,
        },
        balance_prve: None,
        paused: false,
    })
}
