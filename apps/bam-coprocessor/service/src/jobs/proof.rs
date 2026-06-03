//! Job P — every hour, produce one Groth16 proof for the next unproven
//! bam-forum message past the proof watermark. Persists `coprocessor.proofs`
//! + bumps the watermark in a single txn per message.
//!
//! v1 limitation: uses the blocking `prove_c1` wrapper, which only returns
//! after Succinct produces the proof. We do not capture `request_id`
//! synchronously, so a process restart mid-prove forfeits the in-flight
//! request (the proof completes on Succinct but the service loses
//! visibility, paying a duplicate fee on next tick). Follow-up: switch to
//! `sp1_sdk::network::NetworkClient::request_proof` + `wait_proof`,
//! populate `coprocessor.proof_in_flight`, and wire `jobs::recovery`.

use std::sync::Arc;

use bam_coprocessor_script::{
    blob_fetch::decode_hex32,
    parse_message_public_values,
    pipeline::{fetch_one_batch, BatchSelector},
    reader_api::ReaderClient,
    sp1_runner::prove_c1,
};
use chrono::Utc;
use sp1_sdk::{include_elf, Elf};

use crate::db::queries::{self, ProofFullRow, Watermark};
use crate::state::AppState;

const BAM_READER_ELF: Elf = include_elf!("bam-reader-program");

pub async fn run_proof(state: Arc<AppState>) -> anyhow::Result<()> {
    let _p = state.proof_mu.lock().await;

    let chain_id = state.config.chain_id as i64;
    let watermark = queries::read_watermark(&state.pg, "proof", chain_id).await?;
    let limit = state.config.proof_batch_limit as usize;

    let candidates = fetch_unproven_messages(&state, &watermark, limit).await?;
    if candidates.is_empty() {
        tracing::debug!("P tick: no new forum messages past watermark");
        return Ok(());
    }
    tracing::info!(count = candidates.len(), "P tick: candidates");

    for c in candidates {
        if let Err(e) = prove_one(&state, &c).await {
            tracing::error!(
                error = %e,
                block = c.block_number,
                tx = c.tx_index,
                msg = c.msg_index,
                "P tick: prove_one failed, stopping this tick"
            );
            break;
        }
    }
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

async fn fetch_unproven_messages(
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
        let api = client
            .list_messages(&forum_tag, Some("confirmed"), None, 1000)
            .map_err(anyhow::Error::msg)?;
        let mut rows: Vec<Candidate> = api
            .into_iter()
            .filter_map(|m| {
                Some(Candidate {
                    block_number: m.block_number? as i64,
                    tx_index: m.tx_index? as i32,
                    msg_index: m.message_index_within_batch? as i32,
                    batch_ref: m.batch_ref?,
                    expected_message_hash: decode_hex32(&m.message_hash),
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

async fn prove_one(state: &Arc<AppState>, c: &Candidate) -> anyhow::Result<()> {
    let reader_url = state.reader_url.clone();
    let tx_hash = c.batch_ref.clone();
    let chain_id = state.config.chain_id;
    let msg_index = c.msg_index as u32;

    let proof = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
        let client = ReaderClient::new(reader_url);
        let (_api, reader_batch) =
            fetch_one_batch(&client, BatchSelector::TxHash(&tx_hash), chain_id)
                .map_err(anyhow::Error::msg)?;
        prove_c1(BAM_READER_ELF, chain_id, &reader_batch, msg_index, /*groth16=*/ true)
            .map_err(anyhow::Error::msg)
    })
    .await??;

    let pv_bytes = proof.public_values.as_slice().to_vec();
    let pv = parse_message_public_values(&pv_bytes);
    let computed_hash = decode_hex32(&pv.message_hash);
    if computed_hash != c.expected_message_hash {
        anyhow::bail!(
            "messageHash mismatch on prove: C1={} reader={}",
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
    let proof_bytes = proof.bytes();
    let sp1_version = proof.sp1_version.clone();

    let row = ProofFullRow {
        message_hash: computed_hash.to_vec(),
        chain_id: state.config.chain_id as i64,
        versioned_hash: versioned_hash_bytes,
        content_tag: content_tag_bytes,
        start_fe: pv.start_fe as i32,
        end_fe: pv.end_fe as i32,
        block_number: pv.block_number as i64,
        tx_index: pv.tx_index as i32,
        msg_index: pv.msg_index as i32,
        sender: sender_bytes,
        nonce: pv.nonce as i64,
        cycles: 0,
        proof_size: proof_bytes.len() as i32,
        proof_bytes: proof_bytes.clone(),
        public_values: pv_bytes,
        request_id: Vec::new(),
        tx_hash: None,
        proof_type: "groth16".to_string(),
        sp1_version,
        proven_at: Utc::now(),
    };

    let mut tx = state.pg.begin().await?;
    queries::insert_proof(&mut tx, &row).await?;
    let new_wm = Watermark {
        block_number: pv.block_number as i64,
        tx_index: pv.tx_index as i32,
        msg_index: pv.msg_index as i32,
    };
    queries::upsert_watermark(&mut tx, "proof", state.config.chain_id as i64, &new_wm).await?;
    tx.commit().await?;

    tracing::info!(
        message_hash = %pv.message_hash,
        proof_size = row.proof_size,
        "P tick: proof persisted"
    );
    Ok(())
}
