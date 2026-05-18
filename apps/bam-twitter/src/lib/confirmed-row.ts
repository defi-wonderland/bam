/**
 * Wire shape returned by `GET /api/confirmed-messages` and consumed by
 * the Timeline's `fetchConfirmed`. The route serves two upstream paths
 * and merges their wire shape into this single envelope:
 *
 *   - **Indexer path** — `bam-indexer`'s `/twitter/posts`. The payload
 *     is already decoded, so `timestamp` + `content` + `kind` +
 *     `parent_message_hash` + `sender_ens` are populated;
 *     `contents`/`signature` are not shipped.
 *   - **Reader fallback** — `bam-reader`'s `/messages`. The raw
 *     `contents` and `signature` hex are shipped and the consumer
 *     decodes locally; the decoded fields are absent.
 *
 * Both paths emit only confirmed rows, so `tx_hash` is always
 * non-null; `status` is a discriminator the consumer can use without
 * checking which path produced the row.
 */
export interface ConfirmedRow {
  /** ERC-8180 messageHash — stable across pending → confirmed. */
  message_id: string;
  sender: string;
  nonce: string;
  /** Reader-fallback path only. Indexer path omits this. */
  contents?: string;
  /** Reader-fallback path only. Indexer path omits this. */
  signature?: string;
  tx_hash: string;
  block_number: number | null;
  status: 'posted';
  // Indexer-path enrichment — present whenever the indexer answered.
  timestamp?: number;
  content?: string;
  parent_message_hash?: string | null;
  kind?: 'post' | 'reply';
  sender_ens?: string | null;
}
