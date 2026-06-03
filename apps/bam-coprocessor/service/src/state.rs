//! Process-wide state shared between the cron tasks and the HTTP layer.

use std::sync::Arc;

use sqlx::PgPool;
use tokio::sync::Mutex;

use crate::config::Config;

pub struct AppState {
    pub config: Arc<Config>,
    pub pg: PgPool,
    pub reader_url: String,
    /// Decoded `COPROCESSOR_FORUM_TAG`. Reserved for v2 in-circuit tag
    /// binding check; jobs currently rely on the config string.
    #[allow(dead_code)]
    pub forum_tag_bytes: [u8; 32],
    /// Held by Job V while a tick runs; serialises V against itself + P.
    pub validation_mu: Arc<Mutex<()>>,
    /// Held by Job P for its full duration; V try_lock()s this to fence
    /// itself when P is in flight.
    pub proof_mu: Arc<Mutex<()>>,
}

impl AppState {
    pub fn new(config: Config, pg: PgPool, forum_tag_bytes: [u8; 32]) -> Self {
        let reader_url = config.reader_url.clone();
        Self {
            config: Arc::new(config),
            pg,
            reader_url,
            forum_tag_bytes,
            validation_mu: Arc::new(Mutex::new(())),
            proof_mu: Arc::new(Mutex::new(())),
        }
    }
}
