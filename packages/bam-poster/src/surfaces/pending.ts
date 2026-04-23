import type {
  Pending,
  PendingQuery,
  PosterStore,
  StoreTxnPendingRow,
} from '../types.js';

/**
 * `listPending` read surface (trusted; spec §Verification mode).
 * Filters by `contentTag` or spans every tag the Poster serves;
 * returns in per-tag FIFO order.
 */
export async function listPending(
  store: PosterStore,
  query: PendingQuery
): Promise<Pending[]> {
  const rows = await store.withTxn(async (txn) => {
    if (query.contentTag !== undefined) {
      return txn.listPendingByTag(
        query.contentTag,
        query.limit,
        query.since?.ingestSeq
      );
    }
    return txn.listPendingAll(query.limit, query.since?.ingestSeq);
  });
  return rows.map(mapRow);
}

function mapRow(row: StoreTxnPendingRow): Pending {
  return {
    messageId: row.messageId,
    contentTag: row.contentTag,
    author: row.author,
    nonce: row.nonce,
    content: new TextDecoder().decode(row.content),
    timestamp: row.timestamp,
    signature: new Uint8Array(row.signature),
    ingestedAt: row.ingestedAt,
    ingestSeq: row.ingestSeq,
  };
}
