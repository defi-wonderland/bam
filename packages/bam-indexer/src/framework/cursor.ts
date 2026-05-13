/**
 * Per-handler cursor CRUD. Two coordinates live in one row:
 *
 * - **forward cursor** `(blockNumber, txIndex, msgIndex)` — last
 *   confirmed `MessageRow` projected. The next tick polls
 *   `messages` rows whose chain coord is strictly greater.
 * - **reorg cursor** `lastReorgInvalidatedAt` — max
 *   `batches.invalidated_at` already cascaded through `onReorg`.
 *
 * `batches.invalidated_at` is the only monotone "something was
 * reorged" signal in bam-store today; `messages` rows lack an
 * `updated_at` column. Using the batch-level timestamp is correct
 * because `markReorged` updates batch + messages atomically, so a
 * cursor over `batches.invalidated_at` never misses a cascade.
 */

import type { PoolClient } from 'pg';

export interface HandlerCursor {
  handlerName: string;
  handlerVersion: number;
  lastBlockNumber: number;
  lastTxIndex: number;
  lastMsgIndex: number;
  lastReorgInvalidatedAt: number;
  updatedAt: number;
}

export const INDEXER_SCHEMA = 'indexer';
export const CURSOR_TABLE = 'cursor';

export const CREATE_INDEXER_SCHEMA_SQL: readonly string[] = [
  `CREATE SCHEMA IF NOT EXISTS ${INDEXER_SCHEMA}`,
  `CREATE TABLE IF NOT EXISTS ${INDEXER_SCHEMA}.${CURSOR_TABLE} (
    handler_name                text PRIMARY KEY,
    handler_version             integer NOT NULL,
    last_block_number           bigint  NOT NULL,
    last_tx_index               bigint  NOT NULL,
    last_msg_index              bigint  NOT NULL,
    last_reorg_invalidated_at   bigint  NOT NULL,
    updated_at                  bigint  NOT NULL
  )`,
];

/** Sentinel for "before everything." `MessageRow.blockNumber` is non-negative when populated. */
export const CURSOR_GENESIS: Omit<HandlerCursor, 'handlerName' | 'handlerVersion' | 'updatedAt'> = {
  lastBlockNumber: -1,
  lastTxIndex: -1,
  lastMsgIndex: -1,
  lastReorgInvalidatedAt: -1,
};

export async function getCursor(
  client: PoolClient,
  handlerName: string
): Promise<HandlerCursor | null> {
  const res = await client.query<{
    handler_name: string;
    handler_version: number;
    last_block_number: string;
    last_tx_index: string;
    last_msg_index: string;
    last_reorg_invalidated_at: string;
    updated_at: string;
  }>(
    `SELECT handler_name, handler_version, last_block_number, last_tx_index,
            last_msg_index, last_reorg_invalidated_at, updated_at
       FROM ${INDEXER_SCHEMA}.${CURSOR_TABLE}
      WHERE handler_name = $1`,
    [handlerName]
  );
  if (res.rowCount === 0) return null;
  const r = res.rows[0];
  return {
    handlerName: r.handler_name,
    handlerVersion: r.handler_version,
    lastBlockNumber: Number(r.last_block_number),
    lastTxIndex: Number(r.last_tx_index),
    lastMsgIndex: Number(r.last_msg_index),
    lastReorgInvalidatedAt: Number(r.last_reorg_invalidated_at),
    updatedAt: Number(r.updated_at),
  };
}

export async function upsertCursor(
  client: PoolClient,
  cursor: HandlerCursor
): Promise<void> {
  await client.query(
    `INSERT INTO ${INDEXER_SCHEMA}.${CURSOR_TABLE}
       (handler_name, handler_version, last_block_number, last_tx_index,
        last_msg_index, last_reorg_invalidated_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (handler_name) DO UPDATE SET
       handler_version           = EXCLUDED.handler_version,
       last_block_number         = EXCLUDED.last_block_number,
       last_tx_index             = EXCLUDED.last_tx_index,
       last_msg_index            = EXCLUDED.last_msg_index,
       last_reorg_invalidated_at = EXCLUDED.last_reorg_invalidated_at,
       updated_at                = EXCLUDED.updated_at`,
    [
      cursor.handlerName,
      cursor.handlerVersion,
      cursor.lastBlockNumber,
      cursor.lastTxIndex,
      cursor.lastMsgIndex,
      cursor.lastReorgInvalidatedAt,
      cursor.updatedAt,
    ]
  );
}

export async function deleteCursor(
  client: PoolClient,
  handlerName: string
): Promise<void> {
  await client.query(
    `DELETE FROM ${INDEXER_SCHEMA}.${CURSOR_TABLE} WHERE handler_name = $1`,
    [handlerName]
  );
}

/**
 * Strict-greater-than on the lexicographic chain coordinate. Used to
 * build SQL WHERE predicates without an `(a, b, c) > (a0, b0, c0)`
 * row-comparison that PGLite may not support uniformly.
 */
export function gtChainCoordSql(prefix: string, paramOffset: number): { sql: string; params: number[] } {
  const p1 = paramOffset;
  const p2 = paramOffset + 1;
  const p3 = paramOffset + 2;
  const sql = `(
    ${prefix}.block_number > $${p1}
    OR (${prefix}.block_number = $${p1} AND ${prefix}.tx_index > $${p2})
    OR (${prefix}.block_number = $${p1} AND ${prefix}.tx_index = $${p2} AND ${prefix}.message_index_within_batch > $${p3})
  )`;
  return { sql, params: [p1, p2, p3] };
}
