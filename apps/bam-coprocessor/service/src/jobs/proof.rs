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

use anyhow::Context;
use bam_coprocessor_script::{
    blob_fetch::decode_hex32_checked,
    parse_message_public_values, vk_hash_from_groth16,
    pipeline::{fetch_one_batch_reader_only, BatchSelector},
    reader_api::ReaderClient,
    sp1_runner::{execute_c1, prove_c1},
};
use chrono::Utc;
use sp1_sdk::{include_elf, Elf, SP1Proof};
use sp1_verifier::GROTH16_VK_BYTES;

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
        match prove_one(&state, &c).await {
            Ok(true) => {}
            Ok(false) => {
                tracing::info!(
                    block = c.block_number,
                    tx = c.tx_index,
                    msg = c.msg_index,
                    "P tick: reader archive not ready yet, retrying next tick"
                );
                break;
            }
            Err(e) => {
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
        // Manual loop instead of filter_map so a malformed message_hash
        // BAILS the tick (preserving pre-Result-ification semantics) rather
        // than silently dropping the row — which would let the watermark
        // advance past it on the next valid candidate and create a
        // permanent proof gap. Missing Option coords stay a `continue`
        // (legitimate for not-yet-confirmed reader rows).
        let mut rows: Vec<Candidate> = Vec::new();
        for m in api {
            let block = match m.block_number { Some(b) => b as i64, None => continue };
            let tx = match m.tx_index { Some(t) => t as i32, None => continue };
            let msg = match m.message_index_within_batch { Some(i) => i as i32, None => continue };
            let batch_ref = match m.batch_ref { Some(r) => r, None => continue };
            let mh = decode_hex32_checked(&m.message_hash).with_context(|| {
                format!(
                    "reader emitted malformed message_hash at block={block} tx={tx} msg={msg}"
                )
            })?;
            rows.push(Candidate {
                block_number: block,
                tx_index: tx,
                msg_index: msg,
                batch_ref,
                expected_message_hash: mh,
            });
        }
        rows.retain(|c| {
            (c.block_number, c.tx_index, c.msg_index)
                > (watermark.block_number, watermark.tx_index, watermark.msg_index)
        });
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

/// Returns `Ok(true)` on persisted proof, `Ok(false)` when the reader's
/// archive isn't ready yet (transient — caller stops the tick), `Err` on
/// hard failure.
async fn prove_one(state: &Arc<AppState>, c: &Candidate) -> anyhow::Result<bool> {
    let reader_url = state.reader_url.clone();
    let tx_hash = c.batch_ref.clone();
    let chain_id = state.config.chain_id;
    let msg_index = c.msg_index as u32;
    let candidate_block = c.block_number as u64;
    let candidate_tx_index = c.tx_index as u32;

    // Single blocking handoff: fetch batch, capture cycles via execute,
    // then prove. Cycles aren't returned by the network prove path in
    // sp1-sdk 6.x, so the pre-execute is the cleanest way to populate
    // the proof row's `cycles` field. ~3 s additional wall time per
    // proof; trivial next to the network prove latency.
    let outcome = tokio::task::spawn_blocking(
        move || -> anyhow::Result<Option<(u64, sp1_sdk::SP1ProofWithPublicValues)>> {
            let client = ReaderClient::new(reader_url);
            // TODO: BatchSelector::TxHash can't disambiguate when one L1 tx
            // carries multiple BAM batches with different contentTags. The
            // assert below catches any mismatch loudly; the real fix is a
            // (block, txIndex, logIndex) selector once the reader exposes
            // logIndex.
            let (api, reader_batch) =
                match fetch_one_batch_reader_only(&client, BatchSelector::TxHash(&tx_hash))
                    .map_err(anyhow::Error::msg)?
                {
                    Some(pair) => pair,
                    None => return Ok(None),
                };
            anyhow::ensure!(
                api.block_number == Some(candidate_block)
                    && api.tx_index == Some(candidate_tx_index),
                "reader returned batch (block={:?}, tx={:?}) but candidate was (block={}, tx={}) — multi-batch tx?",
                api.block_number,
                api.tx_index,
                candidate_block,
                candidate_tx_index,
            );
            let exec = execute_c1(BAM_READER_ELF, chain_id, &reader_batch, msg_index)
                .map_err(anyhow::Error::msg)?;
            let proof =
                prove_c1(BAM_READER_ELF, chain_id, &reader_batch, msg_index, /*groth16=*/ true)
                    .map_err(anyhow::Error::msg)?;
            Ok(Some((exec.total_cycles, proof)))
        },
    )
    .await??;

    let (cycles, proof) = match outcome {
        Some(pair) => pair,
        None => return Ok(false),
    };

    let pv_bytes = proof.public_values.as_slice().to_vec();
    let pv = parse_message_public_values(&pv_bytes)?;
    let computed_hash = decode_hex32_checked(&pv.message_hash)
        .context("guest emitted malformed message_hash")?;
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
        nonce: i64::try_from(pv.nonce).context("nonce overflows i64")?,
        cycles: i64::try_from(cycles).context("cycles overflow i64")?,
        proof_size: proof_bytes.len() as i32,
        proof_bytes: proof_bytes.clone(),
        public_values: pv_bytes,
        request_id: Vec::new(),
        tx_hash: None,
        proof_type: "groth16".to_string(),
        sp1_version,
        proven_at: Utc::now(),
    };

    // Derive the vk_hash before opening the tx so we never start a write
    // we can't finish. `vk_hash_from_groth16` is pure-data; failure means
    // the proof bytes are malformed (would have failed verification too).
    let vk_cache_pair: Option<(String, String)> = match &proof.proof {
        SP1Proof::Groth16(g16) => match g16.public_inputs.first() {
            Some(first) => match vk_hash_from_groth16(first) {
                Ok(vk_hash) => Some((vk_hash, row.sp1_version.clone())),
                Err(e) => {
                    tracing::warn!(error = %e, "vk_hash_from_groth16 failed; skipping vk_cache write");
                    None
                }
            },
            None => None,
        },
        _ => None,
    };

    let mut tx = state.pg.begin().await?;
    queries::insert_proof(&mut tx, &row).await?;
    let new_wm = Watermark {
        block_number: pv.block_number as i64,
        tx_index: pv.tx_index as i32,
        msg_index: pv.msg_index as i32,
    };
    queries::upsert_watermark(&mut tx, "proof", state.config.chain_id as i64, &new_wm).await?;
    // vk_cache write happens inside the same tx so `/proof/vk` is durably
    // populated alongside every successful proof. If the write fails the
    // tx rolls back; the next tick retries the whole prove-and-persist
    // sequence (Succinct cost) but vk_cache stays consistent with proofs.
    if let Some((vk_hash, sp1_version)) = vk_cache_pair {
        queries::upsert_vk(&mut tx, &vk_hash, GROTH16_VK_BYTES.as_ref(), &sp1_version).await?;
    }
    tx.commit().await?;

    tracing::info!(
        message_hash = %pv.message_hash,
        proof_size = row.proof_size,
        cycles = cycles,
        "P tick: proof persisted"
    );
    Ok(true)
}
