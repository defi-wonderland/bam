import type {
  BamStore,
  BatchRow,
  MessageRow,
  SubmittedBatch,
  SubmittedBatchStatus,
  SubmittedBatchesQuery,
} from '../types.js';

/**
 * `listSubmittedBatches` read surface (locally verifiable past
 * inclusion). Entries are visible within the reorg-tolerance window
 * with their current `status` so clients bound to a stale tx hash
 * can follow the chain.
 *
 * Each per-message entry carries `messageHash` (stable) and `messageId`
 * (batch-scoped; nulled when the parent batch has been reorged out).
 */
export async function listSubmittedBatches(
  store: BamStore,
  query: SubmittedBatchesQuery
): Promise<SubmittedBatch[]> {
  return store.withTxn(async (txn) => {
    const batches = await txn.listBatches({
      contentTag: query.contentTag,
      sinceBlock: query.sinceBlock,
      limit: query.limit,
    });
    const out: SubmittedBatch[] = [];
    for (const b of batches) {
      const msgs = await txn.listMessages({ batchRef: b.txHash });
      out.push(mapBatch(b, msgs));
    }
    return out;
  });
}

function batchToOldStatus(b: BatchRow): SubmittedBatchStatus {
  if (b.status === 'pending_tx') return 'pending';
  if (b.status === 'confirmed') return 'included';
  return b.replacedByTxHash !== null ? 'resubmitted' : 'reorged';
}

function mapBatch(b: BatchRow, msgs: MessageRow[]): SubmittedBatch {
  const status = batchToOldStatus(b);
  const reorged = status === 'reorged' || status === 'resubmitted';
  // Sort messages by the message_index_within_batch so the response is
  // deterministic and matches the ingest order preserved on write.
  const ordered = [...msgs].sort(
    (a, b) => (a.messageIndexWithinBatch ?? 0) - (b.messageIndexWithinBatch ?? 0)
  );
  return {
    txHash: b.txHash,
    contentTag: b.contentTag,
    blobVersionedHash: b.blobVersionedHash,
    batchContentHash: b.batchContentHash,
    blockNumber: b.blockNumber,
    status,
    replacedByTxHash: b.replacedByTxHash,
    submittedAt: b.submittedAt ?? 0,
    invalidatedAt: b.invalidatedAt,
    messages: ordered.map((m) => ({
      sender: m.author,
      nonce: m.nonce,
      contents: new Uint8Array(m.contents),
      signature: new Uint8Array(m.signature),
      messageHash: m.messageHash,
      messageId: reorged ? null : m.messageId,
    })),
  };
}
