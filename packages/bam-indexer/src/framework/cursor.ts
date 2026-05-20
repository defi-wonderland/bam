/**
 * Per-handler cursor CRUD. The cursor table is generation-keyed:
 * every `handler.version` bump bootstraps a new row (fresh `version_id`
 * UUID, cursor at genesis), and the prior row is flipped from
 * `is_current` to a frozen snapshot. Old generations stop advancing
 * but stay queryable.
 *
 * Two coordinates per row:
 * - **forward cursor** `(blockNumber, txIndex, msgIndex)` — last
 *   confirmed `MessageRow` projected for this generation.
 * - **reorg cursor** `lastReorgInvalidatedAt` — max
 *   `batches.invalidated_at` already cascaded through `onReorg`.
 *
 * `batches.invalidated_at` is the only monotone "something was
 * reorged" signal in bam-store today; `messages` rows lack an
 * `updated_at` column. `markReorged` updates batch + messages
 * atomically, so a cursor on the batch-level timestamp never misses
 * a cascade.
 */

import type { PoolClient } from 'pg';

export interface HandlerCursor {
  handlerName: string;
  handlerVersion: number;
  versionId: string;
  isCurrent: boolean;
  supersededAt: number | null;
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
    handler_name              text    NOT NULL,
    handler_version           integer NOT NULL,
    version_id                uuid    NOT NULL,
    is_current                boolean NOT NULL,
    superseded_at             bigint  NULL,
    last_block_number         bigint  NOT NULL,
    last_tx_index             bigint  NOT NULL,
    last_msg_index            bigint  NOT NULL,
    last_reorg_invalidated_at bigint  NOT NULL,
    updated_at                bigint  NOT NULL,
    PRIMARY KEY (handler_name, version_id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS cursor_one_current_per_handler
    ON ${INDEXER_SCHEMA}.${CURSOR_TABLE} (handler_name) WHERE is_current`,
];

/** Sentinel for "before everything." `MessageRow.blockNumber` is non-negative when populated. */
export const CURSOR_GENESIS: Pick<
  HandlerCursor,
  'lastBlockNumber' | 'lastTxIndex' | 'lastMsgIndex' | 'lastReorgInvalidatedAt'
> = {
  lastBlockNumber: -1,
  lastTxIndex: -1,
  lastMsgIndex: -1,
  lastReorgInvalidatedAt: -1,
};

interface CursorRow {
  handler_name: string;
  handler_version: number;
  version_id: string;
  is_current: boolean;
  superseded_at: string | null;
  last_block_number: string;
  last_tx_index: string;
  last_msg_index: string;
  last_reorg_invalidated_at: string;
  updated_at: string;
}

function mapRow(r: CursorRow): HandlerCursor {
  return {
    handlerName: r.handler_name,
    handlerVersion: r.handler_version,
    versionId: r.version_id,
    isCurrent: r.is_current,
    supersededAt: r.superseded_at === null ? null : Number(r.superseded_at),
    lastBlockNumber: Number(r.last_block_number),
    lastTxIndex: Number(r.last_tx_index),
    lastMsgIndex: Number(r.last_msg_index),
    lastReorgInvalidatedAt: Number(r.last_reorg_invalidated_at),
    updatedAt: Number(r.updated_at),
  };
}

/** Current (is_current=true) generation for a handler, or null if none. */
export async function getCurrentCursor(
  client: PoolClient,
  handlerName: string,
): Promise<HandlerCursor | null> {
  const res = await client.query<CursorRow>(
    `SELECT handler_name, handler_version, version_id, is_current, superseded_at,
            last_block_number, last_tx_index, last_msg_index,
            last_reorg_invalidated_at, updated_at
       FROM ${INDEXER_SCHEMA}.${CURSOR_TABLE}
      WHERE handler_name = $1 AND is_current`,
    [handlerName],
  );
  if (res.rowCount === 0) return null;
  return mapRow(res.rows[0]);
}

/** Specific generation by version_id, or null. */
export async function getCursorByVersionId(
  client: PoolClient,
  handlerName: string,
  versionId: string,
): Promise<HandlerCursor | null> {
  const res = await client.query<CursorRow>(
    `SELECT handler_name, handler_version, version_id, is_current, superseded_at,
            last_block_number, last_tx_index, last_msg_index,
            last_reorg_invalidated_at, updated_at
       FROM ${INDEXER_SCHEMA}.${CURSOR_TABLE}
      WHERE handler_name = $1 AND version_id = $2`,
    [handlerName, versionId],
  );
  if (res.rowCount === 0) return null;
  return mapRow(res.rows[0]);
}

/** Every generation for a handler, newest first. */
export async function listCursors(
  client: PoolClient,
  handlerName: string,
): Promise<HandlerCursor[]> {
  const res = await client.query<CursorRow>(
    `SELECT handler_name, handler_version, version_id, is_current, superseded_at,
            last_block_number, last_tx_index, last_msg_index,
            last_reorg_invalidated_at, updated_at
       FROM ${INDEXER_SCHEMA}.${CURSOR_TABLE}
      WHERE handler_name = $1
      ORDER BY is_current DESC, updated_at DESC`,
    [handlerName],
  );
  return res.rows.map(mapRow);
}

export async function upsertCursor(
  client: PoolClient,
  cursor: HandlerCursor,
): Promise<void> {
  await client.query(
    `INSERT INTO ${INDEXER_SCHEMA}.${CURSOR_TABLE}
       (handler_name, handler_version, version_id, is_current, superseded_at,
        last_block_number, last_tx_index, last_msg_index,
        last_reorg_invalidated_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (handler_name, version_id) DO UPDATE SET
       handler_version           = EXCLUDED.handler_version,
       is_current                = EXCLUDED.is_current,
       superseded_at             = EXCLUDED.superseded_at,
       last_block_number         = EXCLUDED.last_block_number,
       last_tx_index             = EXCLUDED.last_tx_index,
       last_msg_index            = EXCLUDED.last_msg_index,
       last_reorg_invalidated_at = EXCLUDED.last_reorg_invalidated_at,
       updated_at                = EXCLUDED.updated_at`,
    [
      cursor.handlerName,
      cursor.handlerVersion,
      cursor.versionId,
      cursor.isCurrent,
      cursor.supersededAt,
      cursor.lastBlockNumber,
      cursor.lastTxIndex,
      cursor.lastMsgIndex,
      cursor.lastReorgInvalidatedAt,
      cursor.updatedAt,
    ],
  );
}

/**
 * Atomically supersede the existing current generation. Run inside
 * the caller's txn — both the flip and the INSERT must commit together
 * or the partial-unique-index invariant ("one current per handler")
 * breaks under concurrent migrate calls.
 */
export async function supersedeCurrent(
  client: PoolClient,
  handlerName: string,
  now: number,
): Promise<void> {
  await client.query(
    `UPDATE ${INDEXER_SCHEMA}.${CURSOR_TABLE}
        SET is_current = false,
            superseded_at = $2,
            updated_at = $2
      WHERE handler_name = $1 AND is_current`,
    [handlerName, now],
  );
}

/** Delete every generation for a handler. Used by `reset --handler --yes`. */
export async function deleteAllCursors(
  client: PoolClient,
  handlerName: string,
): Promise<void> {
  await client.query(
    `DELETE FROM ${INDEXER_SCHEMA}.${CURSOR_TABLE} WHERE handler_name = $1`,
    [handlerName],
  );
}

/** Delete a specific generation. Used by `reset --handler --version <uuid> --yes`. */
export async function deleteCursor(
  client: PoolClient,
  handlerName: string,
  versionId: string,
): Promise<void> {
  await client.query(
    `DELETE FROM ${INDEXER_SCHEMA}.${CURSOR_TABLE}
      WHERE handler_name = $1 AND version_id = $2`,
    [handlerName, versionId],
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
