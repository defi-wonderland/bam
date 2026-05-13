/**
 * Schema + cursor bootstrap. Run once per process start, before the
 * first tick. Mirrors `bam-store`'s "no migration library; rebuild
 * on version bump" posture.
 *
 * Sequence per handler:
 *   1. Ensure `indexer` schema + `indexer.cursor` table exist.
 *   2. Look up `indexer.cursor` row for this handler.
 *   3. If row exists AND `handler_version` differs from
 *      `handler.version`: truncate `<handler.schema>.*` cascade,
 *      delete the cursor row, log `re_backfill_triggered`.
 *   4. Run `handler.migrate(client)` — idempotent DDL.
 */

import type { Pool } from 'pg';

import type { IndexerHandler } from './handler.js';
import type { IndexerLogger } from '../types.js';
import {
  CREATE_INDEXER_SCHEMA_SQL,
  INDEXER_SCHEMA,
  CURSOR_TABLE,
  deleteCursor,
  getCursor,
} from './cursor.js';

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
      const existing = await getCursor(client, h.name);
      if (existing !== null && existing.handlerVersion !== h.version) {
        opts.logger({
          event: 're_backfill_triggered',
          handler: h.name,
          contentTag: h.contentTag,
          detail: {
            from: existing.handlerVersion,
            to: h.version,
            schema: h.schema,
          },
          ts: Date.now(),
        });
        // Truncate the handler's owned schema. CASCADE so any
        // handler-defined FK/views go too. We re-create the schema
        // after the drop so `handler.migrate` can `CREATE TABLE IF
        // NOT EXISTS` cleanly.
        await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(h.schema)} CASCADE`);
        await deleteCursor(client, h.name);
      }
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(h.schema)}`);
      await h.migrate(client);
    }
  } finally {
    client.release();
  }
}

/**
 * Truncate `<schema>.*` + delete the handler's cursor row. Used by
 * the `bam-indexer reset --handler <name>` CLI subcommand and by
 * the version-bump path in `migrate`.
 */
export async function resetHandler(
  writePool: Pool,
  handler: IndexerHandler<unknown>
): Promise<void> {
  const client = await writePool.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(handler.schema)} CASCADE`);
    // The cursor table sits in `indexer.*` so it survives.
    await client.query(
      `DELETE FROM ${INDEXER_SCHEMA}.${CURSOR_TABLE} WHERE handler_name = $1`,
      [handler.name]
    );
    await client.query(`CREATE SCHEMA ${quoteIdent(handler.schema)}`);
    await handler.migrate(client);
  } finally {
    client.release();
  }
}

/**
 * Bare-minimum identifier quoter. Handler `name` / `schema` are
 * authored in-tree (not user input), so the surface area is small,
 * but quoting is still correct discipline — and it lets a handler
 * pick a schema like `bam_twitter` without worrying about reserved
 * words.
 */
function quoteIdent(id: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(id)) {
    throw new Error(`unsafe identifier: ${JSON.stringify(id)}`);
  }
  return `"${id}"`;
}
