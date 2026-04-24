import type {
  Pending,
  PendingQuery,
  BamStore,
  StoreTxnPendingRow,
} from '../types.js';

/**
 * `listPending` read surface. Filters by `contentTag` or spans every
 * tag the Poster serves; returns in per-tag FIFO order.
 */
export async function listPending(
  store: BamStore,
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
    sender: row.sender,
    nonce: row.nonce,
    contentTag: row.contentTag,
    contents: new Uint8Array(row.contents),
    signature: new Uint8Array(row.signature),
    messageHash: row.messageHash,
    ingestedAt: row.ingestedAt,
    ingestSeq: row.ingestSeq,
  };
}
