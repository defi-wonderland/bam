/**
 * Schema + cursor bootstrap. Run once per process start, before the
 * first tick.
 *
 * Sequence per handler:
 *   1. Ensure `indexer` schema + `indexer.cursor` table exist.
 *   2. Look up the **current** `indexer.cursor` row for this handler.
 *   3. If row exists AND `handler_version === handler.version`:
 *      no-op on cursor; just run `handler.migrate(client)` (idempotent
 *      DDL).
 *   4. If row exists AND mismatch: flip the existing row's
 *      `is_current=false` + `superseded_at=now`, INSERT a new row
 *      with a fresh `version_id` (UUID) at `CURSOR_GENESIS`, log
 *      `version_superseded`. Old rows in the handler's tables stay
 *      queryable under their version_id.
 *   5. If no current row exists: INSERT new row with fresh `version_id`
 *      at `CURSOR_GENESIS`.
 *   6. Always run `handler.migrate(client)` after.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

import type { IndexerHandler } from './handler.js';
import type { IndexerLogger } from '../types.js';
import {
  CREATE_INDEXER_SCHEMA_SQL,
  CURSOR_GENESIS,
  deleteAllCursors,
  getCurrentCursor,
  supersedeCurrent,
  upsertCursor,
} from './cursor.js';
import { quoteIdent } from './sql.js';

export interface MigrateOptions {
  writePool: Pool;
  handlers: ReadonlyArray<IndexerHandler<unknown>>;
  logger: IndexerLogger;
}

export async function migrate(opts: MigrateOptions): Promise<void> {
  const client = await opts.writePool.connect();
  try {
    for (const stmt of CREATE_INDEXER_SCHEMA_SQL) {
      await client.query(stmt);
    }

    for (const h of opts.handlers) {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(h.schema)}`);

      const existing = await getCurrentCursor(client, h.name);
      if (existing === null) {
        // First boot for this handler.
        const now = Date.now();
        await upsertCursor(client, {
          handlerName: h.name,
          handlerVersion: h.version,
          versionId: randomUUID(),
          isCurrent: true,
          supersededAt: null,
          ...CURSOR_GENESIS,
          updatedAt: now,
        });
      } else if (existing.handlerVersion !== h.version) {
        // Version bump: supersede old, bootstrap new at genesis.
        // Wrap in a txn so the partial unique index ("one current per
        // handler") sees the flip + INSERT as a single transition.
        const now = Date.now();
        const newVersionId = randomUUID();
        await client.query('BEGIN');
        try {
          await supersedeCurrent(client, h.name, now);
          await upsertCursor(client, {
            handlerName: h.name,
            handlerVersion: h.version,
            versionId: newVersionId,
            isCurrent: true,
            supersededAt: null,
            ...CURSOR_GENESIS,
            updatedAt: now,
          });
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw err;
        }
        opts.logger({
          event: 'version_superseded',
          handler: h.name,
          contentTag: h.contentTag,
          detail: {
            from: existing.handlerVersion,
            to: h.version,
            fromVersionId: existing.versionId,
            toVersionId: newVersionId,
          },
          ts: now,
        });
      }

      await h.migrate(client);
    }
  } finally {
    client.release();
  }
}

/**
 * Drop every generation's rows and cursors for a handler. Backs the
 * `bam-indexer reset --handler <name> --yes` CLI — the nuclear option.
 */
export async function resetHandler(
  writePool: Pool,
  handler: IndexerHandler<unknown>,
): Promise<void> {
  const client = await writePool.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(handler.schema)} CASCADE`);
    await deleteAllCursors(client, handler.name);
    await client.query(`CREATE SCHEMA ${quoteIdent(handler.schema)}`);
    await handler.migrate(client);
  } finally {
    client.release();
  }
}

/**
 * Drop a single generation: its rows + its cursor row. The handler's
 * `deleteVersion` is responsible for the data; this function wraps
 * both in a txn so partial cleanup can't leak.
 */
export async function resetHandlerVersion(
  writePool: Pool,
  handler: IndexerHandler<unknown>,
  versionId: string,
): Promise<void> {
  const client = await writePool.connect();
  try {
    await client.query('BEGIN');
    try {
      await handler.deleteVersion(versionId, client);
      await client.query(
        `DELETE FROM indexer."cursor" WHERE handler_name = $1 AND version_id = $2`,
        [handler.name, versionId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  } finally {
    client.release();
  }
}

/**
 * Drop the current generation for a handler. The next process start
 * sees no current cursor for this handler and bootstraps a fresh
 * version_id at genesis.
 */
export async function resetHandlerCurrent(
  writePool: Pool,
  handler: IndexerHandler<unknown>,
): Promise<void> {
  const client = await writePool.connect();
  try {
    const cur = await getCurrentCursor(client, handler.name);
    if (cur === null) return;
    await client.query('BEGIN');
    try {
      await handler.deleteVersion(cur.versionId, client);
      await client.query(
        `DELETE FROM indexer."cursor" WHERE handler_name = $1 AND version_id = $2`,
        [handler.name, cur.versionId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  } finally {
    client.release();
  }
}
