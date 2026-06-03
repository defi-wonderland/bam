//! Job V — every ~90 s, run the C1 guest in execute mode for each
//! unvalidated bam-forum message past the validation watermark. Persists
//! `coprocessor.validations` rows + bumps the watermark in a single txn
//! per message.
//!
//! Skips ticks when (a) Job V is already running or (b) Job P is mid-prove
//! — the V/P fence is a two-step `try_lock` on the shared mutexes.

use std::sync::Arc;

use bam_coprocessor_script::{
    blob_fetch::decode_hex32,
    parse_message_public_values,
    pipeline::{fetch_one_batch, BatchSelector},
    reader_api::ReaderClient,
    sp1_runner::execute_c1,
};
use sp1_sdk::{include_elf, Elf};

use crate::db::queries::{self, Watermark};
use crate::state::AppState;

const BAM_READER_ELF: Elf = include_elf!("bam-reader-program");

pub async fn run_validation(state: Arc<AppState>) -> anyhow::Result<()> {
    let _v = match state.validation_mu.try_lock() {
        Ok(g) => g,
        Err(_) => {
            tracing::warn!("V tick: prior validation still running, skipping");
            return Ok(());
        }
    };
    let _p = match state.proof_mu.try_lock() {
        Ok(g) => g,
        Err(_) => {
            tracing::info!("V tick: proof in progress, V fenced for this round");
            return Ok(());
        }
    };

    let chain_id = state.config.chain_id as i64;
    let watermark = queries::read_watermark(&state.pg, "validation", chain_id).await?;
    let limit = state.config.validation_batch_limit as usize;

    let candidates = fetch_unvalidated_messages(&state, &watermark, limit).await?;
    if candidates.is_empty() {
        tracing::debug!("V tick: no new forum messages past watermark");
        return Ok(());
    }
    tracing::info!(count = candidates.len(), "V tick: candidates");

    let mut new_wm = watermark.clone();
    for c in candidates {
        match validate_one(&state, &c).await {
            Ok(advanced) => new_wm = advanced,
            Err(e) => {
                tracing::error!(
                    error = %e,
                    block = c.block_number,
                    tx = c.tx_index,
                    msg = c.msg_index,
                    "V tick: validate_one failed, stopping this tick"
                );
                break;
            }
        }
    }

    // Persist the final watermark even if some entries failed midway — the
    // succeeded prefix is durable, so we should not re-process them next
    // tick. validate_one bumps watermark per-message in its own txn.
    let _ = new_wm;
    Ok(())
}

#[derive(Debug, Clone)]
struct Candidate {
    block_number: i64,
    tx_index: i32,
    msg_index: i32,
    batch_ref: String,
    expected_message_hash: [u8; 32],
}

async fn fetch_unvalidated_messages(
    state: &Arc<AppState>,
    watermark: &Watermark,
    limit: usize,
) -> anyhow::Result<Vec<Candidate>> {
    let forum_tag = state.config.forum_tag.clone();
    let reader_url = state.reader_url.clone();
    let watermark = watermark.clone();
    let limit_i = i32::try_from(limit).unwrap_or(i32::MAX);

    let candidates = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<Candidate>> {
        let client = ReaderClient::new(reader_url);
        // Pull a slab of recent forum messages, then filter + sort
        // client-side. Reader caps `limit` at 1000.
        let api = client
            .list_messages(&forum_tag, Some("confirmed"), None, 1000)
            .map_err(anyhow::Error::msg)?;

        let mut rows: Vec<Candidate> = api
            .into_iter()
            .filter_map(|m| {
                let block = m.block_number? as i64;
                let tx = m.tx_index? as i32;
                let msg = m.message_index_within_batch? as i32;
                let batch_ref = m.batch_ref?;
                let mh = decode_hex32(&m.message_hash);
                Some(Candidate {
                    block_number: block,
                    tx_index: tx,
                    msg_index: msg,
                    batch_ref,
                    expected_message_hash: mh,
                })
            })
            .filter(|c| {
                (c.block_number, c.tx_index, c.msg_index)
                    > (watermark.block_number, watermark.tx_index, watermark.msg_index)
            })
            .collect();
        rows.sort_by(|a, b| {
            (a.block_number, a.tx_index, a.msg_index).cmp(&(
                b.block_number,
                b.tx_index,
                b.msg_index,
            ))
        });
        rows.truncate(limit_i as usize);
        Ok(rows)
    })
    .await??;

    Ok(candidates)
}

async fn validate_one(state: &Arc<AppState>, c: &Candidate) -> anyhow::Result<Watermark> {
    let reader_url = state.reader_url.clone();
    let tx_hash = c.batch_ref.clone();
    let chain_id = state.config.chain_id;
    let msg_index = c.msg_index as u32;

    let exec_output = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
        let client = ReaderClient::new(reader_url);
        let (_api, reader_batch) =
            fetch_one_batch(&client, BatchSelector::TxHash(&tx_hash), chain_id)
                .map_err(anyhow::Error::msg)?;
        execute_c1(BAM_READER_ELF, chain_id, &reader_batch, msg_index)
            .map_err(anyhow::Error::msg)
    })
    .await??;

    let pv = parse_message_public_values(&exec_output.public_values);
    let computed_hash = decode_hex32(&pv.message_hash);
    if computed_hash != c.expected_message_hash {
        anyhow::bail!(
            "messageHash mismatch: C1={} reader={}",
            pv.message_hash,
            hex::encode(c.expected_message_hash)
        );
    }

    let sender_bytes =
        hex::decode(pv.sender.trim_start_matches("0x")).map_err(anyhow::Error::msg)?;
    let versioned_hash_bytes =
        hex::decode(pv.versioned_hash.trim_start_matches("0x")).map_err(anyhow::Error::msg)?;
    let content_tag_bytes =
        hex::decode(pv.content_tag.trim_start_matches("0x")).map_err(anyhow::Error::msg)?;

    let mut tx = state.pg.begin().await?;
    queries::insert_validation(
        &mut tx,
        &computed_hash,
        pv.chain_id as i64,
        &versioned_hash_bytes,
        &content_tag_bytes,
        pv.start_fe as i32,
        pv.end_fe as i32,
        pv.block_number as i64,
        pv.tx_index as i32,
        pv.msg_index as i32,
        &sender_bytes,
        pv.nonce as i64,
        exec_output.total_cycles as i64,
    )
    .await?;
    let new_wm = Watermark {
        block_number: pv.block_number as i64,
        tx_index: pv.tx_index as i32,
        msg_index: pv.msg_index as i32,
    };
    queries::upsert_watermark(&mut tx, "validation", state.config.chain_id as i64, &new_wm).await?;
    tx.commit().await?;

    tracing::info!(
        message_hash = %pv.message_hash,
        cycles = exec_output.total_cycles,
        "V tick: validated"
    );
    Ok(new_wm)
}
