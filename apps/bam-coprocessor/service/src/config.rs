//! Service configuration sourced from environment variables.

use std::env;

use anyhow::{anyhow, Result};

#[derive(Debug, Clone)]
pub struct Config {
    pub db_url: String,
    pub reader_url: String,
    pub http_bind: String,
    pub http_port: u16,
    pub chain_id: u64,
    pub forum_tag: String,

    /// Cron expression for Job V. Format follows tokio-cron-scheduler's
    /// 6-field cron (`sec min hour day month weekday`). Default: every 90 s.
    pub validation_cron: String,
    /// Cron expression for Job P. Default: every hour at :00.
    pub proof_cron: String,

    /// Hard cap on per-tick message count for Job V (default 50).
    pub validation_batch_limit: u32,
    /// Hard cap on per-tick proof count for Job P (default 1).
    pub proof_batch_limit: u32,

    /// Pause Job P when Succinct balance falls below this (in PROVE).
    /// 0.0 means "never pause on balance". Read but not yet consulted by
    /// jobs in v1 — balance check lands with the NetworkClient migration.
    #[allow(dead_code)]
    pub prove_balance_threshold: f64,
}

fn env_str(key: &str) -> Result<String> {
    env::var(key).map_err(|_| anyhow!("missing required env var: {key}"))
}

fn env_str_or(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.to_string())
}

fn env_parse<T: std::str::FromStr>(key: &str, default: T) -> Result<T>
where
    <T as std::str::FromStr>::Err: std::fmt::Display,
{
    match env::var(key) {
        Ok(v) => v
            .parse::<T>()
            .map_err(|e| anyhow!("invalid {key}: {e}")),
        Err(_) => Ok(default),
    }
}

impl Config {
    pub fn from_env() -> Result<Self> {
        Ok(Self {
            db_url: env_str("COPROCESSOR_DB_URL")?,
            reader_url: env_str("COPROCESSOR_READER_URL")?,
            http_bind: env_str_or("COPROCESSOR_HTTP_BIND", "0.0.0.0"),
            http_port: env_parse("COPROCESSOR_HTTP_PORT", 8790u16)?,
            chain_id: env_parse("COPROCESSOR_CHAIN_ID", 11155111u64)?,
            forum_tag: env_str_or(
                "COPROCESSOR_FORUM_TAG",
                "0x01bc15204a4c7779a37fd0d7988fe89a9cc4a148e7db926f4815f4c93ea879d1",
            ),
            // Every 90 s. Cron syntax: `sec min hour day month weekday`.
            validation_cron: env_str_or("COPROCESSOR_VALIDATION_CRON", "*/90 * * * * *"),
            // Top of every hour.
            proof_cron: env_str_or("COPROCESSOR_PROOF_CRON", "0 0 * * * *"),
            validation_batch_limit: env_parse("COPROCESSOR_VALIDATION_BATCH_LIMIT", 50u32)?,
            proof_batch_limit: env_parse("COPROCESSOR_PROOF_BATCH_LIMIT", 1u32)?,
            prove_balance_threshold: env_parse("COPROCESSOR_PROVE_BALANCE_THRESHOLD", 0.0f64)?,
        })
    }
}
