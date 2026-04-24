import type { Bytes32 } from 'bam-sdk';

import type {
  BamStore,
  BatchRow,
  MessageRow,
  StoreTxn,
  SubmittedBatch,
  SubmittedBatchMessage,
  SubmittedBatchStatus,
  SubmittedBatchesQuery,
} from '../types.js';

/**
 * `listSubmittedBatches` read surface (locally verifiable past
 * inclusion). Entries are visible within the reorg-tolerance window
 * with their current `status` so clients bound to a stale tx hash
 * can follow the chain.
 *
 * Filters to batches the caller's Poster wrote: same `chainId` AND a
 * non-null `submittedAt`. In a shared-DB Poster+Reader scenario, a
 * batch observed by the Reader without ever being submitted by us has
 * `submittedAt = null`; that batch isn't ours to surface as
 * "submitted." Filtering on `submittedAt !== null` keeps the response
 * faithful to the surface's name.
 *
 * Each batch's messages are read via the batch's frozen
 * `messageSnapshot` rather than by querying `messages.batch_ref`. The
 * snapshot is set at confirmation and never overwritten, so a reorged
 * batch still surfaces the messages it contained even after the
 * underlying message rows have been re-enqueued and resubmitted in a
 * different batch.
 */
export async function listSubmittedBatches(
  store: BamStore,
  chainId: number,
  query: SubmittedBatchesQuery
): Promise<SubmittedBatch[]> {
  return store.withTxn(async (txn) => {
    // Don't apply the caller's `limit` at the SQL layer. The
    // null-`submittedAt` filter (the "is this our row?" discriminator)
    // is applied locally; if we limited at SQL we could fill the entire
    // window with Reader-observed rows and end up returning fewer
    // Poster-submitted rows than the caller asked for, even though
    // more exist further down. Over-fetch (no SQL limit), filter,
    // then slice.
    const batches = await txn.listBatches({
      chainId,
      contentTag: query.contentTag,
      sinceBlock: query.sinceBlock,
    });
    const out: SubmittedBatch[] = [];
    for (const b of batches) {
      if (b.submittedAt === null) continue;
      const msgs = await readSnapshotMessages(txn, b);
      out.push(mapBatch(b, msgs));
      if (typeof query.limit === 'number' && out.length >= query.limit) break;
    }
    return out;
  });
}

interface SnapshotJoinRow {
  row: MessageRow | null;
  messageIdAtConfirm: Bytes32;
  messageIdxWithinBatch: number;
}

async function readSnapshotMessages(
  txn: StoreTxn,
  b: BatchRow
): Promise<SnapshotJoinRow[]> {
  const out: SnapshotJoinRow[] = [];
  for (const e of b.messageSnapshot) {
    const row = await txn.getByAuthorNonce(e.author, e.nonce);
    out.push({
      row,
      messageIdAtConfirm: e.messageId,
      messageIdxWithinBatch: e.messageIndexWithinBatch,
    });
  }
  return out;
}

function batchToOldStatus(b: BatchRow): SubmittedBatchStatus {
  if (b.status === 'pending_tx') return 'pending';
  if (b.status === 'confirmed') return 'included';
  return b.replacedByTxHash !== null ? 'resubmitted' : 'reorged';
}

function mapBatch(b: BatchRow, msgs: SnapshotJoinRow[]): SubmittedBatch {
  const status = batchToOldStatus(b);
  const reorged = status === 'reorged' || status === 'resubmitted';
  // Snapshot order is the encoded batch order; sort defensively in case
  // a backend returned the snapshot in a different order.
  const ordered = [...msgs].sort(
    (a, b) => a.messageIdxWithinBatch - b.messageIdxWithinBatch
  );
  const mappedMessages: SubmittedBatchMessage[] = [];
  for (const m of ordered) {
    if (m.row === null) {
      // Snapshot entry whose underlying messages row was deleted —
      // shouldn't happen in v1 (no retention/pruning), but skip defensively.
      continue;
    }
    mappedMessages.push({
      sender: m.row.author,
      nonce: m.row.nonce,
      contents: new Uint8Array(m.row.contents),
      signature: new Uint8Array(m.row.signature),
      messageHash: m.row.messageHash,
      // After reorg, surface messageId as null (the batch-scoped id is
      // no longer valid). For active batches, return the snapshot's
      // messageId — this is the value that was correct at confirmation,
      // even if the messages row's `message_id` column has since been
      // overwritten by a resubmission to a different batch.
      messageId: reorged ? null : m.messageIdAtConfirm,
    });
  }
  return {
    txHash: b.txHash,
    contentTag: b.contentTag,
    blobVersionedHash: b.blobVersionedHash,
    batchContentHash: b.batchContentHash,
    blockNumber: b.blockNumber,
    status,
    replacedByTxHash: b.replacedByTxHash,
    // `submittedAt === null` rows are filtered out by listSubmittedBatches
    // before mapBatch runs, so the cast is sound — this surface only ever
    // shows batches the Poster itself wrote.
    submittedAt: b.submittedAt as number,
    invalidatedAt: b.invalidatedAt,
    messages: mappedMessages,
  };
}
