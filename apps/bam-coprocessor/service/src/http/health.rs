//! `GET /health` — observation surface for ops + the fly health check.
//!
//! Returns 503 with `{error: "db_unhealthy"}` on any DB read failure so
//! Fly's check fails (and rolls the machine) during Postgres outages.

use std::sync::Arc;

use axum::{extract::State, http::StatusCode, Json};
use serde::Serialize;
use serde_json::{json, Value};

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
    pub watermark: WatermarkCoord,
    pub message_count: i64,
}

#[derive(Debug, Serialize)]
pub struct ProofHealth {
    pub last_at: Option<String>,
    pub last_message_hash: Option<String>,
    pub watermark: WatermarkCoord,
    pub message_count: i64,
    pub in_flight_count: i64,
}

#[derive(Debug, Serialize)]
pub struct WatermarkCoord {
    pub block_number: i64,
    pub tx_index: i32,
    pub msg_index: i32,
}

pub async fn handler(
    State(state): State<Arc<AppState>>,
) -> Result<Json<HealthResponse>, (StatusCode, Json<Value>)> {
    let chain_id = state.config.chain_id as i64;
    let pool = &state.pg;

    let v_wm = queries::read_watermark(pool, "validation", chain_id)
        .await
        .map_err(|e| db_unhealthy("read_watermark(validation)", e))?;
    let p_wm = queries::read_watermark(pool, "proof", chain_id)
        .await
        .map_err(|e| db_unhealthy("read_watermark(proof)", e))?;
    let v_count = queries::validations_count(pool, chain_id)
        .await
        .map_err(|e| db_unhealthy("validations_count", e))?;
    let p_count = queries::proof_count(pool, chain_id)
        .await
        .map_err(|e| db_unhealthy("proof_count", e))?;
    let v_at = queries::last_validation_at(pool, chain_id)
        .await
        .map_err(|e| db_unhealthy("last_validation_at", e))?;
    let last_p = queries::last_proof(pool, chain_id)
        .await
        .map_err(|e| db_unhealthy("last_proof", e))?;
    let in_flight = queries::in_flight_count(pool)
        .await
        .map_err(|e| db_unhealthy("in_flight_count", e))?;

    Ok(Json(HealthResponse {
        healthy: true,
        validation: JobHealth {
            last_at: v_at.map(|t| t.to_rfc3339()),
            watermark: WatermarkCoord {
                block_number: v_wm.block_number,
                tx_index: v_wm.tx_index,
                msg_index: v_wm.msg_index,
            },
            message_count: v_count,
        },
        proof: ProofHealth {
            last_at: last_p.as_ref().map(|(t, _)| t.to_rfc3339()),
            last_message_hash: last_p
                .as_ref()
                .map(|(_, h)| crate::http::json::hex_prefixed(h)),
            watermark: WatermarkCoord {
                block_number: p_wm.block_number,
                tx_index: p_wm.tx_index,
                msg_index: p_wm.msg_index,
            },
            message_count: p_count,
            in_flight_count: in_flight,
        },
        balance_prve: None,
        paused: false,
    }))
}

fn db_unhealthy(query: &str, err: anyhow::Error) -> (StatusCode, Json<Value>) {
    tracing::error!(query = query, error = %err, "/health: db query failed");
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({ "healthy": false, "error": "db_unhealthy" })),
    )
}
