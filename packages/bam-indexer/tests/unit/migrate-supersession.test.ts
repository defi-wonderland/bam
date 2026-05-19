/**
 * `migrate`'s version-bump path: bumping `handler.version` flips the
 * existing current row's `is_current=false` and INSERTs a new current
 * row at genesis under a fresh `version_id`. Old generations stay
 * queryable; new generations re-index from scratch.
 */

import { describe, expect, it } from 'vitest';
import type { Bytes32 } from 'bam-sdk';

import { migrate } from '../../src/framework/migrate.js';
import { createPostReplyHandler } from '../../src/handlers/post-reply/handler.js';

const TWITTER_TAG = ('0x' + 'f0'.repeat(32)) as Bytes32;

interface CursorState {
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

class FakeClient {
  cursorRows = new Map<string, CursorState>();

  rowsByHandler(name: string): CursorState[] {
    return [...this.cursorRows.values()].filter((r) => r.handler_name === name);
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rowCount: number; rows: unknown[] }> {
    if (sql.includes('FROM indexer.') && sql.includes('WHERE handler_name = $1 AND is_current')) {
      const handlerName = String(params[0]);
      for (const r of this.cursorRows.values()) {
        if (r.handler_name === handlerName && r.is_current) {
          return { rowCount: 1, rows: [r] };
        }
      }
      return { rowCount: 0, rows: [] };
    }
    if (sql.startsWith('INSERT INTO indexer."cursor"') || sql.startsWith('INSERT INTO indexer.cursor')) {
      const next: CursorState = {
        handler_name: String(params[0]),
        handler_version: Number(params[1]),
        version_id: String(params[2]),
        is_current: Boolean(params[3]),
        superseded_at: params[4] === null ? null : String(params[4]),
        last_block_number: String(params[5]),
        last_tx_index: String(params[6]),
        last_msg_index: String(params[7]),
        last_reorg_invalidated_at: String(params[8]),
        updated_at: String(params[9]),
      };
      this.cursorRows.set(`${next.handler_name}|${next.version_id}`, next);
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('UPDATE') && sql.includes('SET is_current = false')) {
      const handlerName = String(params[0]);
      const ts = String(params[1]);
      for (const r of this.cursorRows.values()) {
        if (r.handler_name === handlerName && r.is_current) {
          r.is_current = false;
          r.superseded_at = ts;
          r.updated_at = ts;
        }
      }
      return { rowCount: 1, rows: [] };
    }
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rowCount: 0, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  }
  release(): void {
    /* noop */
  }
}

class FakePool {
  constructor(public readonly client: FakeClient) {}
  async connect(): Promise<FakeClient> {
    return this.client;
  }
  end(): Promise<void> {
    return Promise.resolve();
  }
  on(): this {
    return this;
  }
}

describe('migrate — supersession', () => {
  it('first boot inserts a single current cursor at genesis', async () => {
    const client = new FakeClient();
    const pool = new FakePool(client);
    const handler = createPostReplyHandler({
      name: 'twitter',
      contentTag: TWITTER_TAG,
      schema: 'twitter',
      version: 1,
    });
    await migrate({ writePool: pool as never, handlers: [handler], logger: () => undefined });
    const rows = client.rowsByHandler('twitter');
    expect(rows).toHaveLength(1);
    expect(rows[0].is_current).toBe(true);
    expect(rows[0].handler_version).toBe(1);
    expect(rows[0].last_block_number).toBe('-1');
    expect(rows[0].superseded_at).toBeNull();
    // UUID shape
    expect(rows[0].version_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('re-running with the same handler.version is a no-op on the cursor row', async () => {
    const client = new FakeClient();
    const pool = new FakePool(client);
    const handler = createPostReplyHandler({
      name: 'twitter',
      contentTag: TWITTER_TAG,
      schema: 'twitter',
      version: 1,
    });
    await migrate({ writePool: pool as never, handlers: [handler], logger: () => undefined });
    const firstVid = client.rowsByHandler('twitter')[0].version_id;
    await migrate({ writePool: pool as never, handlers: [handler], logger: () => undefined });
    const rows = client.rowsByHandler('twitter');
    expect(rows).toHaveLength(1);
    expect(rows[0].version_id).toBe(firstVid);
  });

  it('bumping handler.version supersedes the old row and INSERTs a new current at genesis', async () => {
    const client = new FakeClient();
    const pool = new FakePool(client);
    const v1 = createPostReplyHandler({
      name: 'twitter',
      contentTag: TWITTER_TAG,
      schema: 'twitter',
      version: 1,
    });
    await migrate({ writePool: pool as never, handlers: [v1], logger: () => undefined });
    const oldVid = client.rowsByHandler('twitter')[0].version_id;

    // Simulate prior progress on v1 so the supersession freezes a non-genesis cursor.
    client.cursorRows.get(`twitter|${oldVid}`)!.last_block_number = '500';

    const v2 = createPostReplyHandler({
      name: 'twitter',
      contentTag: TWITTER_TAG,
      schema: 'twitter',
      version: 2,
    });
    const events: Array<{ event: string; detail?: unknown }> = [];
    await migrate({
      writePool: pool as never,
      handlers: [v2],
      logger: (e) => events.push({ event: e.event, detail: e.detail }),
    });

    const rows = client.rowsByHandler('twitter');
    expect(rows).toHaveLength(2);
    const oldRow = rows.find((r) => r.version_id === oldVid);
    const newRow = rows.find((r) => r.version_id !== oldVid);
    if (!oldRow || !newRow) throw new Error('unexpected row set');

    expect(oldRow.is_current).toBe(false);
    expect(oldRow.superseded_at).not.toBeNull();
    expect(oldRow.handler_version).toBe(1);
    expect(oldRow.last_block_number).toBe('500'); // frozen at supersession

    expect(newRow.is_current).toBe(true);
    expect(newRow.handler_version).toBe(2);
    expect(newRow.last_block_number).toBe('-1'); // genesis
    expect(newRow.superseded_at).toBeNull();
    expect(newRow.version_id).not.toBe(oldVid);

    const supersededEvents = events.filter((e) => e.event === 'version_superseded');
    expect(supersededEvents).toHaveLength(1);
  });
});
