import type {
  BamStore,
  StoreTxnSubmittedRow,
  SubmittedBatch,
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
  const rows = await store.withTxn(async (txn) => txn.listSubmitted(query));
  return rows.map(mapRow);
}

function mapRow(row: StoreTxnSubmittedRow): SubmittedBatch {
  const reorged = row.status === 'reorged';
  return {
    txHash: row.txHash,
    contentTag: row.contentTag,
    blobVersionedHash: row.blobVersionedHash,
    batchContentHash: row.batchContentHash,
    blockNumber: row.blockNumber,
    status: row.status,
    replacedByTxHash: row.replacedByTxHash,
    submittedAt: row.submittedAt,
    invalidatedAt: row.invalidatedAt,
    messages: row.messages.map((m) => ({
      sender: m.sender,
      nonce: m.nonce,
      contents: new Uint8Array(m.contents),
      signature: new Uint8Array(m.signature),
      messageHash: m.messageHash,
      messageId: reorged ? null : m.messageId,
    })),
  };
}
