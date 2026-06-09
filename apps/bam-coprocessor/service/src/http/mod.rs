pub mod health;
pub mod json;
pub mod proof_get;
pub mod proof_list;
pub mod proof_vk;
pub mod validation;

use std::sync::Arc;

use axum::{routing::get, Router};
use tower_http::trace::TraceLayer;

use crate::state::AppState;

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health::handler))
        .route("/validation/latest", get(validation::handler))
        .route("/proof", get(proof_list::handler))
        .route("/proof/vk", get(proof_vk::handler))
        .route("/proof/by-blob/:versioned_hash", get(proof_get::by_versioned_hash))
        .route("/proof/:message_hash", get(proof_get::by_message_hash))
        .with_state(state)
        .layer(TraceLayer::new_for_http())
}
