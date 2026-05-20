/**
 * Read-only source over `bam-store`'s Postgres. Issues hand-written
 * SELECTs — we don't pull in `drizzle-orm` just to read two tables.
 * Schema column names match `packages/bam-store/src/schema/ddl.ts`.
 *
 * The indexer's source is intentionally minimal: two queries
 * (`listConfirmedAfter`, `listReorgedAfter`). Anything richer
 * belongs in a handler's own routes, not here.
 */

import type { Address, Bytes32 } from 'bam-sdk';
import type { MessageRow, MessageStatus } from 'bam-store';
import pg from 'pg';
const { Pool } = pg;

type PgPool = pg.Pool;

export interface ChainCoord {
  blockNumber: number;
  txIndex: number;
  msgIndex: number;
}

export interface ListConfirmedAfterArgs {
  chainId: number;
  contentTag: Bytes32;
  after: ChainCoord;
  limit: number;
}

export interface ListReorgedAfterArgs {
  chainId: number;
  contentTag: Bytes32;
  /** Exclusive lower bound on `batches.invalidated_at`. */
  afterInvalidatedAt: number;
  limit: number;
}

export interface ReorgEntry {
  txHash: Bytes32;
  invalidatedAt: number;
}

export class BamStoreSource {
  constructor(private readonly pool: PgPool) {}

  static fromUrl(url: string): BamStoreSource {
    const pool = new Pool({ connectionString: url });
    // pg surfaces idle-client errors on the pool; without a listener
    // Node treats them as unhandled and exits. Matches the posture
    // in `packages/bam-store/src/db-store.ts:48`.
    pool.on('error', (err: unknown) => {
      try {
        const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
        process.stderr.write(`[bam-indexer] idle pg client error: ${detail}\n`);
      } catch {
        // ignore
      }
    });
    return new BamStoreSource(pool);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Confirmed messages with chain coord strictly greater than
   * `after`, filtered to the configured chain + contentTag. Ordered
   * by `(block_number, tx_index, message_index_within_batch)`
   * ascending so a single forward pass yields stable cursoring.
   */
  async listConfirmedAfter(args: ListConfirmedAfterArgs): Promise<MessageRow[]> {
    const res = await this.pool.query<RawMessage>(
      `SELECT sender, nonce, content_tag, contents, signature,
              message_hash, message_id, status, batch_ref, chain_id,
              ingested_at, ingest_seq, block_number, tx_index,
              message_index_within_batch
         FROM messages
        WHERE status = 'confirmed'
          AND content_tag = $1
          AND chain_id = $2
          AND block_number IS NOT NULL
          AND tx_index IS NOT NULL
          AND message_index_within_batch IS NOT NULL
          AND (
            block_number > $3
            OR (block_number = $3 AND tx_index > $4)
            OR (block_number = $3 AND tx_index = $4 AND message_index_within_batch > $5)
          )
        ORDER BY block_number ASC, tx_index ASC, message_index_within_batch ASC
        LIMIT $6`,
      [
        args.contentTag,
        args.chainId,
        args.after.blockNumber,
        args.after.txIndex,
        args.after.msgIndex,
        args.limit,
      ]
    );
    return res.rows.map(mapMessage);
  }

  /**
   * Reorged batch entries for this chain + contentTag, strictly
   * after `afterInvalidatedAt`. Ordered by `(invalidated_at,
   * tx_hash)` so ties are broken deterministically.
   */
  async listReorgedAfter(args: ListReorgedAfterArgs): Promise<ReorgEntry[]> {
    const res = await this.pool.query<{ tx_hash: string; invalidated_at: string }>(
      `SELECT tx_hash, invalidated_at
         FROM batches
        WHERE status = 'reorged'
          AND chain_id = $1
          AND content_tag = $2
          AND invalidated_at IS NOT NULL
          AND invalidated_at > $3
        ORDER BY invalidated_at ASC, tx_hash ASC
        LIMIT $4`,
      [args.chainId, args.contentTag, args.afterInvalidatedAt, args.limit]
    );
    return res.rows.map((r) => ({
      txHash: r.tx_hash as Bytes32,
      invalidatedAt: Number(r.invalidated_at),
    }));
  }
}

interface RawMessage {
  sender: string;
  nonce: string;
  content_tag: string;
  contents: Uint8Array;
  signature: Uint8Array;
  message_hash: string;
  message_id: string | null;
  status: string;
  batch_ref: string | null;
  chain_id: string | null;
  ingested_at: string | null;
  ingest_seq: string | null;
  block_number: string | null;
  tx_index: string | null;
  message_index_within_batch: string | null;
}

function asUint8(value: Uint8Array): Uint8Array {
  return value.constructor === Uint8Array ? value : new Uint8Array(value);
}

function mapMessage(raw: RawMessage): MessageRow {
  return {
    messageId: raw.message_id as Bytes32 | null,
    sender: raw.sender as Address,
    nonce: BigInt(raw.nonce),
    contentTag: raw.content_tag as Bytes32,
    contents: asUint8(raw.contents),
    signature: asUint8(raw.signature),
    messageHash: raw.message_hash as Bytes32,
    status: raw.status as MessageStatus,
    batchRef: raw.batch_ref as Bytes32 | null,
    chainId: raw.chain_id === null ? null : Number(raw.chain_id),
    ingestedAt: raw.ingested_at === null ? null : Number(raw.ingested_at),
    ingestSeq: raw.ingest_seq === null ? null : Number(raw.ingest_seq),
    blockNumber: raw.block_number === null ? null : Number(raw.block_number),
    txIndex: raw.tx_index === null ? null : Number(raw.tx_index),
    messageIndexWithinBatch:
      raw.message_index_within_batch === null ? null : Number(raw.message_index_within_batch),
  };
}
