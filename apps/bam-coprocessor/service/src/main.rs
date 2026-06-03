//! bam-coprocessor-service — drives Circuit 1 on two cron cadences and
//! serves the HTTP API the bam-forum-demo Vercel proxy consumes.

mod config;
mod db;
mod http;
mod jobs;
mod state;

use std::sync::Arc;

use sqlx::postgres::PgPoolOptions;
use tokio_cron_scheduler::{Job, JobScheduler};
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,bam_coprocessor_service=debug")),
        )
        .json()
        .init();

    let cfg = Config::from_env()?;
    tracing::info!(
        chain_id = cfg.chain_id,
        forum_tag = %cfg.forum_tag,
        reader_url = %cfg.reader_url,
        "bam-coprocessor-service starting"
    );

    let forum_tag_bytes: [u8; 32] = {
        let hex = cfg.forum_tag.trim_start_matches("0x");
        let decoded = hex::decode(hex)?;
        decoded
            .try_into()
            .map_err(|_| anyhow::anyhow!("COPROCESSOR_FORUM_TAG must decode to 32 bytes"))?
    };

    let pg = PgPoolOptions::new()
        .max_connections(8)
        .connect(&cfg.db_url)
        .await?;
    db::ensure_schema(&pg).await?;
    tracing::info!("coprocessor.* schema ensured");

    let bind = format!("{}:{}", cfg.http_bind, cfg.http_port);
    let validation_cron = cfg.validation_cron.clone();
    let proof_cron = cfg.proof_cron.clone();
    let state = Arc::new(AppState::new(cfg, pg, forum_tag_bytes));

    jobs::recovery::recover_in_flight_proofs(state.clone()).await?;

    let scheduler = JobScheduler::new().await?;
    let v_state = state.clone();
    scheduler
        .add(Job::new_async(validation_cron.as_str(), move |_uuid, _l| {
            let s = v_state.clone();
            Box::pin(async move {
                if let Err(e) = jobs::validation::run_validation(s).await {
                    tracing::error!(error = %e, "V tick failed");
                }
            })
        })?)
        .await?;
    let p_state = state.clone();
    scheduler
        .add(Job::new_async(proof_cron.as_str(), move |_uuid, _l| {
            let s = p_state.clone();
            Box::pin(async move {
                if let Err(e) = jobs::proof::run_proof(s).await {
                    tracing::error!(error = %e, "P tick failed");
                }
            })
        })?)
        .await?;
    scheduler.start().await?;
    tracing::info!(
        validation_cron = %validation_cron,
        proof_cron = %proof_cron,
        "cron scheduler running"
    );

    let app = http::router(state.clone());
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!(addr = %bind, "HTTP listening");

    let shutdown = async {
        tokio::signal::ctrl_c().await.ok();
        tracing::info!("ctrl-c received, shutting down");
    };
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await?;

    Ok(())
}
