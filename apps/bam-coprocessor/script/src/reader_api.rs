//! Blocking HTTP client for the bam-reader read API.
//!
//! Keep the surface narrow — only what the coprocessor host paths need:
//!   - GET /batches/:txHash         (single batch by L1 tx hash)
//!   - GET /batches?contentTag=…    (list, filterable by status / since)
//!   - GET /messages?contentTag=…   (list, filterable by batchRef)

use serde::{Deserialize, Serialize};

/// Subset of a `/batches` row we consume. bam-reader emits Bytes32/Address
/// as `0x`-prefixed hex; `blockNumber` / `txIndex` come as JSON numbers.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiBatch {
    pub tx_hash: String,
    pub blob_versioned_hash: String,
    pub content_tag: String,
    pub block_number: Option<u64>,
    pub tx_index: Option<u32>,
    #[serde(default)]
    pub l1_included_at_unix_sec: Option<i64>,
    #[serde(default)]
    pub submitter: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct BatchEnvelope {
    pub batch: ApiBatch,
}

#[derive(Debug, Deserialize)]
pub struct BatchesResponse {
    pub batches: Vec<ApiBatch>,
}

/// Subset of a `/messages` row we consume.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiMessage {
    pub sender: String,
    pub nonce: String,
    pub contents: String,
    pub message_hash: String,
    pub batch_ref: Option<String>,
    pub block_number: Option<u64>,
    pub tx_index: Option<u32>,
    pub message_index_within_batch: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct MessagesResponse {
    pub messages: Vec<ApiMessage>,
}

pub struct ReaderClient {
    base_url: String,
}

impl ReaderClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn get_batch(&self, tx_hash: &str) -> Result<ApiBatch, String> {
        let url = format!("{}/batches/{}", self.base_url, tx_hash);
        let resp = ureq::get(&url).call().map_err(|e| e.to_string())?;
        let env: BatchEnvelope = resp.into_json().map_err(|e| e.to_string())?;
        Ok(env.batch)
    }

    /// `since_unix_sec` translates to the bam-reader `?since=` filter
    /// (inclusive lower bound on `l1IncludedAtUnixSec`). `limit` is
    /// hard-capped at 1000 by the reader; pass that for "as much as
    /// possible" semantics.
    pub fn list_batches(
        &self,
        content_tag: &str,
        status: Option<&str>,
        since_unix_sec: Option<i64>,
        limit: u32,
    ) -> Result<Vec<ApiBatch>, String> {
        let mut url = format!(
            "{}/batches?contentTag={}&limit={}",
            self.base_url, content_tag, limit
        );
        if let Some(s) = status {
            url.push_str(&format!("&status={s}"));
        }
        if let Some(t) = since_unix_sec {
            url.push_str(&format!("&since={t}"));
        }
        let resp = ureq::get(&url).call().map_err(|e| e.to_string())?;
        let body: BatchesResponse = resp.into_json().map_err(|e| e.to_string())?;
        Ok(body.batches)
    }

    pub fn list_messages(
        &self,
        content_tag: &str,
        status: Option<&str>,
        batch_ref: Option<&str>,
        limit: u32,
    ) -> Result<Vec<ApiMessage>, String> {
        let mut url = format!(
            "{}/messages?contentTag={}&limit={}",
            self.base_url, content_tag, limit
        );
        if let Some(s) = status {
            url.push_str(&format!("&status={s}"));
        }
        if let Some(b) = batch_ref {
            url.push_str(&format!("&batchRef={b}"));
        }
        let resp = ureq::get(&url).call().map_err(|e| e.to_string())?;
        let body: MessagesResponse = resp.into_json().map_err(|e| e.to_string())?;
        Ok(body.messages)
    }
}
