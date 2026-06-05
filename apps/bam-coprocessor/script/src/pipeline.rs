//! Host-side pipeline glue: resolve a `bam-reader` batch entry, fetch its
//! blob bytes, generate the KZG commitment + opening proof, and assemble a
//! `BlobInput` ready to feed into the C1 guest program.

use bam_coprocessor_lib::BlobInput;

use crate::blob_fetch::{
    decode_hex32_checked, fetch_blob_bytes, fetch_blob_from_reader_only,
};
use crate::kzg::generate_kzg_proof;
use crate::reader_api::{ApiBatch, ReaderClient};

/// bam-store does not yet persist `start_fe`/`end_fe` from the
/// BlobSegmentDeclared event, so the coprocessor cannot read the actual
/// segment bounds from the Reader.  For the demo all messages use the
/// full blob (poster does not split segments), so clamping to [0, 4096]
/// is correct in practice.  Before enabling on-chain verification these
/// constants must be replaced with values read from bam-store/bam-reader.
pub const DEFAULT_START_FE: u16 = 0;
pub const DEFAULT_END_FE: u16 = 4096;

/// Identify a target batch on the reader by L1 tx hash (preferred path)
/// or by `(block_number, tx_index)` within a `contentTag`'s confirmed
/// list (filtered locally).
pub enum BatchSelector<'a> {
    TxHash(&'a str),
    ChainCoord {
        content_tag: &'a str,
        block_number: u64,
        tx_index: u32,
    },
}

/// Resolve `selector` to an `ApiBatch`.
pub fn resolve_batch(
    client: &ReaderClient,
    selector: BatchSelector<'_>,
) -> Result<ApiBatch, String> {
    match selector {
        BatchSelector::TxHash(tx_hash) => client.get_batch(tx_hash),
        BatchSelector::ChainCoord {
            content_tag,
            block_number,
            tx_index,
        } => {
            let batches = client.list_batches(content_tag, Some("confirmed"), None, 1000)?;
            batches
                .into_iter()
                .find(|b| b.block_number == Some(block_number) && b.tx_index == Some(tx_index))
                .ok_or_else(|| {
                    format!(
                        "no confirmed batch for contentTag={content_tag} block={block_number} tx={tx_index}"
                    )
                })
        }
    }
}

/// Fetch one batch end-to-end: locate via `selector`, pull blob bytes,
/// re-derive its versioned hash via KZG, and produce a guest-ready
/// `BlobInput`. Returns both the `ApiBatch` (for host metadata) and the
/// `BlobInput` (the SP1 stdin payload).
pub fn fetch_one_batch(
    client: &ReaderClient,
    selector: BatchSelector<'_>,
    chain_id: u64,
) -> Result<(ApiBatch, BlobInput), String> {
    let api = resolve_batch(client, selector)?;
    let block_number = api
        .block_number
        .ok_or_else(|| "confirmed batch missing block_number".to_string())?;
    let tx_index = api
        .tx_index
        .ok_or_else(|| "confirmed batch missing tx_index".to_string())?;
    let l1_vh =
        decode_hex32_checked(&api.blob_versioned_hash).map_err(|e| e.to_string())?;

    let blob_bytes = fetch_blob_bytes(
        client.base_url(),
        &api.blob_versioned_hash,
        &l1_vh,
        block_number,
        chain_id,
    );
    let (commitment, opening_proof, computed_vh) =
        generate_kzg_proof(&blob_bytes).map_err(|e| e.to_string())?;
    if computed_vh != l1_vh {
        return Err(format!(
            "blob versioned_hash mismatch (block={block_number} tx={tx_index})"
        ));
    }

    let reader_batch = BlobInput {
        versioned_hash: l1_vh,
        commitment,
        opening_proof,
        content_tag: decode_hex32_checked(&api.content_tag).map_err(|e| e.to_string())?,
        decoder: [0u8; 20],
        sig_registry: [0u8; 20],
        block_number,
        tx_index,
        start_fe: DEFAULT_START_FE,
        end_fe: DEFAULT_END_FE,
        blob_bytes,
    };
    Ok((api, reader_batch))
}

/// Strict reader-archive variant of `fetch_one_batch`. Returns
/// `Ok(None)` when (a) the reader hasn't processed the L1 event yet
/// (`l1_included_at_unix_sec` is null), or (b) the reader's archive
/// hasn't written the blob yet (`/blobs/:vh` returns 404). Either case
/// is transient — the caller should skip this candidate and retry on
/// the next tick.
///
/// Avoids the beacon-API fallback so the service never depends on the
/// slot calibration (which drifts). For long-tail blobs (archive
/// permanently missing), the caller should fall back to a different
/// flow or surface the gap.
pub fn fetch_one_batch_reader_only(
    client: &ReaderClient,
    selector: BatchSelector<'_>,
) -> Result<Option<(ApiBatch, BlobInput)>, String> {
    let api = resolve_batch(client, selector)?;
    let block_number = api
        .block_number
        .ok_or_else(|| "confirmed batch missing block_number".to_string())?;
    let tx_index = api
        .tx_index
        .ok_or_else(|| "confirmed batch missing tx_index".to_string())?;

    // l1_included_at_unix_sec is set only when the reader has processed
    // the L1 event itself. The poster's eager confirm write leaves it
    // null, so this catches the poster-vs-reader race window.
    if api.l1_included_at_unix_sec.is_none() {
        return Ok(None);
    }

    let blob_bytes = match fetch_blob_from_reader_only(client.base_url(), &api.blob_versioned_hash)? {
        Some(b) => b,
        None => return Ok(None),
    };

    let l1_vh =
        decode_hex32_checked(&api.blob_versioned_hash).map_err(|e| e.to_string())?;
    let (commitment, opening_proof, computed_vh) =
        generate_kzg_proof(&blob_bytes).map_err(|e| e.to_string())?;
    if computed_vh != l1_vh {
        return Err(format!(
            "blob versioned_hash mismatch (block={block_number} tx={tx_index})"
        ));
    }

    let reader_batch = BlobInput {
        versioned_hash: l1_vh,
        commitment,
        opening_proof,
        content_tag: decode_hex32_checked(&api.content_tag).map_err(|e| e.to_string())?,
        decoder: [0u8; 20],
        sig_registry: [0u8; 20],
        block_number,
        tx_index,
        start_fe: DEFAULT_START_FE,
        end_fe: DEFAULT_END_FE,
        blob_bytes,
    };
    Ok(Some((api, reader_batch)))
}
