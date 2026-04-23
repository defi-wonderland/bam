import type {
  PosterStore,
  StoreTxnSubmittedRow,
  SubmittedBatch,
  SubmittedBatchesQuery,
} from '../types.js';

/**
 * `listSubmittedBatches` read surface (locally verifiable past
 * inclusion; spec §Verification mode). Entries are visible within
 * the reorg-tolerance window with their current `status` so clients
 * bound to a stale tx hash can follow the chain.
 */
export async function listSubmittedBatches(
  store: PosterStore,
  query: SubmittedBatchesQuery
): Promise<SubmittedBatch[]> {
  const rows = await store.withTxn(async (txn) => txn.listSubmitted(query));
  return rows.map(mapRow);
}

function mapRow(row: StoreTxnSubmittedRow): SubmittedBatch {
  return {
    txHash: row.txHash,
    contentTag: row.contentTag,
    blobVersionedHash: row.blobVersionedHash,
    blockNumber: row.blockNumber,
    status: row.status,
    replacedByTxHash: row.replacedByTxHash,
    submittedAt: row.submittedAt,
    messageIds: [...row.messageIds],
  };
}
