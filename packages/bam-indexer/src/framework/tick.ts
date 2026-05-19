/**
 * Per-handler tick. Two ordered phases, both operating on the
 * handler's **current** generation cursor:
 *
 *   1. Forward pass — read confirmed `MessageRow`s with chain
 *      coordinate strictly greater than the current cursor; decode
 *      → resolve enrichments → call `project(..., versionId)` and
 *      bump the forward cursor in the same write txn. Frozen
 *      generations don't tick — they only see reorg-driven
 *      evictions via the cascade-by-batch_ref DELETE.
 *
 *   2. Reorg pass — read `batches` rows where `status='reorged'`
 *      AND `invalidated_at` > the current cursor's reorg coord;
 *      call `handler.onReorg(txHash, chainId, txn)` once per batch.
 *      The handler's DELETE is scoped to `batch_ref` (not
 *      `version_id`), so a single statement evicts the batch from
 *      every generation that projected it.
 *
 * `markReorged` in bam-store atomically transitions batch + messages
 * status, so cursoring on `batches.invalidated_at` cannot miss a
 * cascade. Reader writes `batches.invalidated_at` as a monotonic ms
 * timestamp; ties are broken by deterministic ordering on `tx_hash`
 * so two competing reorgs at the same ms surface in a stable order.
 */

import type { Pool, PoolClient } from 'pg';
import type { Bytes32 } from 'bam-sdk';
import type { MessageRow } from 'bam-store';

import type { IndexerHandler } from './handler.js';
import type { HandlerRegistry } from './registry.js';
import {
  getCurrentCursor,
  upsertCursor,
  type HandlerCursor,
} from './cursor.js';
import type { EnricherPool } from '../enrichers/types.js';
import type { BamStoreSource, ReorgEntry } from '../source/bam-store-source.js';
import type { IndexerLogger, HandlerCounters } from '../types.js';
import { emptyHandlerCounters } from '../types.js';

export interface TickOptions {
  chainId: number;
  registry: HandlerRegistry;
  source: BamStoreSource;
  writePool: Pool;
  enrichers: EnricherPool;
  logger: IndexerLogger;
  batchSize: number;
}

export interface TickResult {
  byHandler: Record<string, HandlerCounters>;
}

export async function tick(opts: TickOptions): Promise<TickResult> {
  const result: TickResult = { byHandler: {} };
  for (const handler of opts.registry.all()) {
    result.byHandler[handler.name] = await tickHandler(handler, opts);
  }
  return result;
}

async function tickHandler<E>(
  handler: IndexerHandler<E>,
  opts: TickOptions,
): Promise<HandlerCounters> {
  const counters = emptyHandlerCounters();
  const cursor = await readCurrentCursor(opts.writePool, handler);
  if (cursor === null) {
    // Should never happen — `migrate` bootstraps a current cursor
    // before the first tick. Surface and skip rather than throw so
    // one mis-migrated handler doesn't wedge the whole loop.
    opts.logger({
      event: 'source_error',
      handler: handler.name,
      contentTag: handler.contentTag,
      detail: { reason: 'no current cursor; did migrate run?' },
      ts: Date.now(),
    });
    return counters;
  }

  let forward = cursor;
  const rows = await opts.source.listConfirmedAfter({
    chainId: opts.chainId,
    contentTag: handler.contentTag,
    after: {
      blockNumber: forward.lastBlockNumber,
      txIndex: forward.lastTxIndex,
      msgIndex: forward.lastMsgIndex,
    },
    limit: opts.batchSize,
  });

  for (const row of rows) {
    const next = await projectOne(handler, row, forward, opts, counters);
    if (next === null) {
      // `null` means `handler.project` threw — `projectOne` rolled
      // back the txn so the cursor was NOT persisted. Stop here: if
      // a later row succeeded, its `upsertCursor` would jump the
      // persisted cursor past this failed row and lose the retry.
      // (Decode failure returns the advanced cursor, not null, so a
      //  poison payload doesn't wedge the loop.)
      break;
    }
    forward = next;
  }

  const reorged = await opts.source.listReorgedAfter({
    chainId: opts.chainId,
    contentTag: handler.contentTag,
    afterInvalidatedAt: forward.lastReorgInvalidatedAt,
    limit: opts.batchSize,
  });

  for (const r of reorged) {
    const next = await reorgOne(handler, r, forward, opts, counters);
    if (next === null) break;
    forward = next;
  }

  return counters;
}

async function readCurrentCursor<E>(
  pool: Pool,
  handler: IndexerHandler<E>,
): Promise<HandlerCursor | null> {
  const c = await pool.connect();
  try {
    return await getCurrentCursor(c, handler.name);
  } finally {
    c.release();
  }
}

async function projectOne<E>(
  handler: IndexerHandler<E>,
  row: MessageRow,
  forward: HandlerCursor,
  opts: TickOptions,
  counters: HandlerCounters,
): Promise<HandlerCursor | null> {
  let decoded: E | null;
  try {
    decoded = handler.decode(row.contents);
  } catch {
    decoded = null;
  }

  const advanced: HandlerCursor = {
    ...forward,
    lastBlockNumber: row.blockNumber ?? forward.lastBlockNumber,
    lastTxIndex: row.txIndex ?? forward.lastTxIndex,
    lastMsgIndex: row.messageIndexWithinBatch ?? forward.lastMsgIndex,
    updatedAt: Date.now(),
  };

  if (decoded === null) {
    counters.skippedDecode += 1;
    opts.logger({
      event: 'handler_skipped_decode',
      handler: handler.name,
      contentTag: handler.contentTag,
      detail: { sender: row.sender, nonce: row.nonce.toString() },
      ts: Date.now(),
    });
    await runInTxn(opts.writePool, async (txn) => {
      await upsertCursor(txn, advanced);
    });
    return advanced;
  }

  const enriched = await opts.enrichers.resolve(handler, row);

  try {
    await runInTxn(opts.writePool, async (txn) => {
      await handler.project(row, decoded as E, enriched, txn, forward.versionId);
      await upsertCursor(txn, advanced);
    });
    counters.projected += 1;
    opts.logger({
      event: 'handler_projected',
      handler: handler.name,
      contentTag: handler.contentTag,
      detail: { sender: row.sender, nonce: row.nonce.toString() },
      ts: Date.now(),
    });
    return advanced;
  } catch (err) {
    counters.skippedConflict += 1;
    opts.logger({
      event: 'handler_skipped_conflict',
      handler: handler.name,
      contentTag: handler.contentTag,
      detail: {
        sender: row.sender,
        nonce: row.nonce.toString(),
        error: err instanceof Error ? err.message : String(err),
      },
      ts: Date.now(),
    });
    // Don't advance the cursor — the next tick will retry. If the
    // failure is poison-row, the operator will see repeated
    // `handler_skipped_conflict` events with the same nonce and can
    // intervene.
    return null;
  }
}

async function reorgOne<E>(
  handler: IndexerHandler<E>,
  entry: ReorgEntry,
  forward: HandlerCursor,
  opts: TickOptions,
  counters: HandlerCounters,
): Promise<HandlerCursor | null> {
  const advanced: HandlerCursor = {
    ...forward,
    lastReorgInvalidatedAt: Math.max(
      forward.lastReorgInvalidatedAt,
      entry.invalidatedAt,
    ),
    updatedAt: Date.now(),
  };
  try {
    await runInTxn(opts.writePool, async (txn) => {
      await handler.onReorg(entry.txHash as Bytes32, opts.chainId, txn);
      await upsertCursor(txn, advanced);
    });
    counters.reorged += 1;
    opts.logger({
      event: 'handler_reorged',
      handler: handler.name,
      contentTag: handler.contentTag,
      detail: { txHash: entry.txHash, invalidatedAt: entry.invalidatedAt },
      ts: Date.now(),
    });
    return advanced;
  } catch (err) {
    opts.logger({
      event: 'handler_skipped_conflict',
      handler: handler.name,
      contentTag: handler.contentTag,
      detail: {
        txHash: entry.txHash,
        error: err instanceof Error ? err.message : String(err),
      },
      ts: Date.now(),
    });
    return null;
  }
}

async function runInTxn<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore — original error wins
    }
    throw err;
  } finally {
    client.release();
  }
}
