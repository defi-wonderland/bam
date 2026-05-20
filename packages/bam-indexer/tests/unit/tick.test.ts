/**
 * `tick` integration over a fake source + fake write pool. The fake
 * `Pool` records every SQL statement and models a tiny in-memory
 * `indexer.cursor` table so we can assert:
 *
 *  - forward pass projects every row decoded by the handler and
 *    advances the current cursor exactly once per row;
 *  - malformed payloads bump `skippedDecode` AND still advance the
 *    cursor (no wedge on a poison row);
 *  - project-side conflict leaves the cursor unchanged so the next
 *    tick retries;
 *  - reorg pass calls `onReorg` and bumps the reorg cursor;
 *  - cursor row is INSERTED on first migrate when nothing exists yet.
 */

import { describe, expect, it } from 'vitest';
import { encodePostReplyContents } from 'bam-sdk/post-reply';
import type { Address, Bytes32 } from 'bam-sdk';
import type { MessageRow } from 'bam-store';

import { HandlerRegistry } from '../../src/framework/registry.js';
import { migrate } from '../../src/framework/migrate.js';
import { tick } from '../../src/framework/tick.js';
import type { BamStoreSource, ReorgEntry } from '../../src/source/bam-store-source.js';
import type { EnricherPool } from '../../src/enrichers/types.js';
import type { IndexerHandler } from '../../src/framework/handler.js';
import { createPostReplyHandler } from '../../src/handlers/post-reply/handler.js';

const TWITTER_TAG = ('0x' + 'f0'.repeat(32)) as Bytes32;
const twitterHandler = createPostReplyHandler({
  name: 'twitter',
  contentTag: TWITTER_TAG,
  schema: 'twitter',
});

interface Recorded {
  sql: string;
  params: unknown[];
}

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
  readonly queries: Recorded[] = [];
  cursorRows = new Map<string, CursorState>();
  shouldFailProject = false;
  projectFailFirst = 0;
  deleteFailFirst = 0;
  private projectAttempts = 0;
  private deleteAttempts = 0;
  twitterRows: Array<{ messageId: string; batchRef: string; versionId: string }> = [];

  /** Test helper: most-recent current cursor (mirrors the old single-row shape). */
  get cursorRow(): CursorState | null {
    for (const r of this.cursorRows.values()) {
      if (r.is_current) return r;
    }
    return null;
  }

  /** Test helper: stash a pre-seeded cursor row keyed by version_id. */
  seedCursor(row: CursorState): void {
    this.cursorRows.set(`${row.handler_name}|${row.version_id}`, row);
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rowCount: number; rows: unknown[] }> {
    this.queries.push({ sql, params });
    // SELECT current cursor.
    if (sql.includes('FROM indexer.') && sql.includes('WHERE handler_name = $1 AND is_current')) {
      const handlerName = String(params[0]);
      for (const r of this.cursorRows.values()) {
        if (r.handler_name === handlerName && r.is_current) {
          return { rowCount: 1, rows: [r] };
        }
      }
      return { rowCount: 0, rows: [] };
    }
    // SELECT cursor by version_id.
    if (sql.includes('FROM indexer.') && sql.includes('handler_name = $1 AND version_id = $2')) {
      const k = `${String(params[0])}|${String(params[1])}`;
      const r = this.cursorRows.get(k);
      return r ? { rowCount: 1, rows: [r] } : { rowCount: 0, rows: [] };
    }
    // INSERT/UPSERT cursor.
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
    // UPDATE … SET is_current = false (supersede).
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
    if (sql.includes('INSERT INTO "twitter".posts')) {
      this.projectAttempts += 1;
      if (this.shouldFailProject || this.projectAttempts <= this.projectFailFirst) {
        throw new Error('synthetic project failure');
      }
      // INSERT column order: version_id, message_id, message_hash, sender, nonce, kind,
      // timestamp, content, parent_message_hash, batch_ref, …
      const versionId = String(params[0]);
      const messageId = String(params[1]);
      const batchRef = String(params[9]);
      this.twitterRows.push({ messageId, batchRef, versionId });
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('DELETE FROM "twitter".posts')) {
      this.deleteAttempts += 1;
      if (this.deleteAttempts <= this.deleteFailFirst) {
        throw new Error('synthetic onReorg failure');
      }
      const ref = String(params[0]);
      this.twitterRows = this.twitterRows.filter((r) => r.batchRef !== ref);
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

class FakeSource implements Pick<BamStoreSource, 'listConfirmedAfter' | 'listReorgedAfter'> {
  constructor(
    public readonly rows: MessageRow[],
    public readonly reorgs: ReorgEntry[] = []
  ) {}
  async listConfirmedAfter(args: {
    after: { blockNumber: number; txIndex: number; msgIndex: number };
    limit: number;
  }): Promise<MessageRow[]> {
    return this.rows
      .filter((r) => {
        if (r.blockNumber === null || r.txIndex === null || r.messageIndexWithinBatch === null) return false;
        if (r.blockNumber !== args.after.blockNumber) return r.blockNumber > args.after.blockNumber;
        if (r.txIndex !== args.after.txIndex) return r.txIndex > args.after.txIndex;
        return r.messageIndexWithinBatch > args.after.msgIndex;
      })
      .slice(0, args.limit);
  }
  async listReorgedAfter(args: {
    afterInvalidatedAt: number;
    limit: number;
  }): Promise<ReorgEntry[]> {
    return this.reorgs
      .filter((r) => r.invalidatedAt > args.afterInvalidatedAt)
      .slice(0, args.limit);
  }
}

class FakeEnricherPool implements EnricherPool {
  async resolve(): Promise<Record<string, never>> {
    return {};
  }
}

const SENDER = ('0x' + 'aa'.repeat(20)) as Address;
const TX_HASH = ('0x' + 'cc'.repeat(32)) as Bytes32;
const MESSAGE_HASH = ('0x' + 'ee'.repeat(32)) as Bytes32;

function row(idx: number, contents: Uint8Array, txHash = TX_HASH): MessageRow {
  return {
    messageId: ('0x' + idx.toString(16).padStart(64, '0')) as Bytes32,
    sender: SENDER,
    nonce: BigInt(idx),
    contentTag: TWITTER_TAG,
    contents,
    signature: new Uint8Array(65),
    messageHash: MESSAGE_HASH,
    status: 'confirmed',
    batchRef: txHash,
    chainId: 11155111,
    ingestedAt: null,
    ingestSeq: null,
    blockNumber: 100 + idx,
    txIndex: idx,
    messageIndexWithinBatch: 0,
  };
}

function makeTickOpts(opts: {
  source: BamStoreSource;
  pool: FakePool;
  enrichers?: EnricherPool;
  events?: Array<{ event: string; handler?: string }>;
  handlers?: IndexerHandler<unknown>[];
}): Parameters<typeof tick>[0] {
  return {
    chainId: 11155111,
    registry: new HandlerRegistry(opts.handlers ?? [twitterHandler]),
    source: opts.source,
    writePool: opts.pool as never,
    enrichers: opts.enrichers ?? new FakeEnricherPool(),
    logger: (e) => opts.events?.push({ event: e.event, handler: e.handler }),
    batchSize: 100,
  };
}

/**
 * Bootstrap-then-tick wrapper. Mirrors what the live indexer does:
 * `migrate` establishes a current cursor for every handler, then `tick`
 * advances it. Returns the migrated current cursor's `version_id` so
 * tests can assert against it.
 */
async function bootstrapAndTick(
  opts: Parameters<typeof tick>[0],
): Promise<{ version_id: string }> {
  await migrate({
    writePool: opts.writePool,
    handlers: opts.registry.all(),
    logger: opts.logger,
  });
  await tick(opts);
  const client = opts.writePool as unknown as FakePool;
  const cur = client.client.cursorRow;
  if (cur === null) throw new Error('expected a current cursor after migrate');
  return { version_id: cur.version_id };
}

describe('tick — forward pass', () => {
  it('projects every confirmed row and advances the cursor monotonically', async () => {
    const bytesA = encodePostReplyContents({ kind: 'post', timestamp: 1, content: 'a' });
    const bytesB = encodePostReplyContents({ kind: 'post', timestamp: 2, content: 'b' });
    const source = new FakeSource([row(1, bytesA), row(2, bytesB)]);
    const client = new FakeClient();
    const pool = new FakePool(client);
    const events: Array<{ event: string; handler?: string }> = [];
    const opts = makeTickOpts({ source: source as never, pool, events });
    const { version_id } = await bootstrapAndTick(opts);
    // Both rows landed in twitter.posts under the bootstrapped version_id.
    expect(client.twitterRows).toHaveLength(2);
    expect(client.twitterRows.every((r) => r.versionId === version_id)).toBe(true);
    // Cursor advanced to the last row's chain coord.
    expect(client.cursorRow?.last_block_number).toBe(String(102));
    expect(client.cursorRow?.last_tx_index).toBe(String(2));
  });

  it('skips malformed payloads but advances the cursor past them', async () => {
    const good = encodePostReplyContents({ kind: 'post', timestamp: 1, content: 'a' });
    const bad = new Uint8Array(5); // too short
    const source = new FakeSource([row(1, bad), row(2, good)]);
    const client = new FakeClient();
    const pool = new FakePool(client);
    await bootstrapAndTick(makeTickOpts({ source: source as never, pool }));
    expect(client.twitterRows).toHaveLength(1);
    expect(client.cursorRow?.last_block_number).toBe(String(102));
  });

  it('does NOT advance the cursor when project itself throws', async () => {
    const good = encodePostReplyContents({ kind: 'post', timestamp: 1, content: 'a' });
    const source = new FakeSource([row(1, good)]);
    const client = new FakeClient();
    client.shouldFailProject = true;
    const pool = new FakePool(client);
    await bootstrapAndTick(makeTickOpts({ source: source as never, pool }));
    // Bootstrap seeded at -1; the failed project shouldn't have advanced it.
    expect(client.cursorRow?.last_block_number).toBe(String(-1));
  });

  it('stops at first project failure; later rows are not processed and cursor stays put', async () => {
    const a = encodePostReplyContents({ kind: 'post', timestamp: 1, content: 'a' });
    const b = encodePostReplyContents({ kind: 'post', timestamp: 2, content: 'b' });
    const source = new FakeSource([row(1, a), row(2, b)]);
    const client = new FakeClient();
    client.projectFailFirst = 1; // first INSERT throws, second would succeed
    const pool = new FakePool(client);
    await bootstrapAndTick(makeTickOpts({ source: source as never, pool }));
    expect(client.twitterRows).toHaveLength(0);
    expect(client.cursorRow?.last_block_number).toBe(String(-1));
    expect(client.cursorRow?.last_tx_index).toBe(String(-1));
  });
});

describe('tick — reorg pass', () => {
  it('calls onReorg for each reorged batch and bumps the reorg cursor', async () => {
    const good = encodePostReplyContents({ kind: 'post', timestamp: 1, content: 'a' });
    const source = new FakeSource(
      [row(1, good)],
      [
        { txHash: TX_HASH, invalidatedAt: 1000 },
      ]
    );
    const client = new FakeClient();
    const pool = new FakePool(client);
    await bootstrapAndTick(makeTickOpts({ source: source as never, pool }));
    expect(client.twitterRows).toHaveLength(0); // forward projected then reorg dropped
    expect(client.cursorRow?.last_reorg_invalidated_at).toBe(String(1000));
  });

  it('older reorgs (already cursored) are not replayed', async () => {
    const source = new FakeSource(
      [],
      [{ txHash: TX_HASH, invalidatedAt: 500 }]
    );
    const client = new FakeClient();
    // Pre-seed a current cursor past the reorg.
    client.seedCursor({
      handler_name: 'twitter',
      handler_version: 1,
      version_id: '00000000-0000-4000-8000-0000000000aa',
      is_current: true,
      superseded_at: null,
      last_block_number: String(100),
      last_tx_index: String(0),
      last_msg_index: String(0),
      last_reorg_invalidated_at: String(1000),
      updated_at: String(Date.now()),
    });
    const pool = new FakePool(client);
    // Skip the bootstrap helper — we want the seed intact, not a fresh genesis.
    await migrate({
      writePool: pool as never,
      handlers: [twitterHandler],
      logger: () => undefined,
    });
    const result = await tick(makeTickOpts({ source: source as never, pool }));
    expect(result.byHandler.twitter.reorged).toBe(0);
  });

  it('stops at first onReorg failure; later reorgs are not processed and cursor stays put', async () => {
    const txA = ('0x' + '11'.repeat(32)) as Bytes32;
    const txB = ('0x' + '22'.repeat(32)) as Bytes32;
    const source = new FakeSource(
      [],
      [
        { txHash: txA, invalidatedAt: 500 },
        { txHash: txB, invalidatedAt: 1000 },
      ]
    );
    const client = new FakeClient();
    client.deleteFailFirst = 1; // first onReorg DELETE throws, second would succeed
    const pool = new FakePool(client);
    await bootstrapAndTick(makeTickOpts({ source: source as never, pool }));
    expect(client.cursorRow?.last_reorg_invalidated_at).toBe(String(-1));
  });
});
