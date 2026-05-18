/**
 * `tick` integration over fake source + fake write pool.
 *
 * The fake `Pool` records every SQL statement so we can assert:
 *  - forward pass projects every row decoded by the handler and
 *    advances the cursor exactly once per row;
 *  - malformed payloads bump `skippedDecode` AND still advance the
 *    cursor (no wedge on a poison row);
 *  - project-side conflict leaves the cursor unchanged so the next
 *    tick retries;
 *  - reorg pass calls `onReorg` and bumps the reorg cursor;
 *  - cursor row is INSERTED on first tick when nothing exists yet.
 */

import { describe, expect, it } from 'vitest';
import { encodePostReplyContents } from 'bam-app-codecs/post-reply';
import type { Address, Bytes32 } from 'bam-sdk';
import type { MessageRow } from 'bam-store';

import { HandlerRegistry } from '../../src/framework/registry.js';
import { tick } from '../../src/framework/tick.js';
import type { BamStoreSource, ReorgEntry } from '../../src/source/bam-store-source.js';
import type { EnricherPool } from '../../src/enrichers/types.js';
import type { IndexerHandler } from '../../src/framework/handler.js';
import { createPostReplyHandler } from '../../src/handlers/post-reply/handler.js';

// Local fixture: a `post-reply` handler with twitter-shaped opts so the
// SQL these tests assert against (twitter.posts) stays byte-identical.
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

class FakeClient {
  readonly queries: Recorded[] = [];
  cursorRow: Record<string, unknown> | null = null;
  shouldFailProject = false;
  // Per-attempt failure: throw on the first N project / delete attempts,
  // then succeed. Lets tests model failure-then-success scenarios.
  projectFailFirst = 0;
  deleteFailFirst = 0;
  private projectAttempts = 0;
  private deleteAttempts = 0;
  twitterRows: Array<{ messageId: string; batchRef: string }> = [];

  async query(sql: string, params: unknown[] = []): Promise<{ rowCount: number; rows: unknown[] }> {
    this.queries.push({ sql, params });
    if (sql.startsWith('SELECT handler_name')) {
      if (this.cursorRow === null) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [this.cursorRow] };
    }
    if (sql.startsWith('INSERT INTO indexer."cursor"') || sql.startsWith('INSERT INTO indexer.cursor')) {
      // cursor upsert: stash params so subsequent SELECTs see it
      this.cursorRow = {
        handler_name: params[0],
        handler_version: params[1],
        last_block_number: String(params[2]),
        last_tx_index: String(params[3]),
        last_msg_index: String(params[4]),
        last_reorg_invalidated_at: String(params[5]),
        updated_at: String(params[6]),
      };
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('INSERT INTO "twitter".posts')) {
      this.projectAttempts += 1;
      if (this.shouldFailProject || this.projectAttempts <= this.projectFailFirst) {
        throw new Error('synthetic project failure');
      }
      const messageId = String(params[0]);
      // INSERT column order: message_id, message_hash, sender, nonce, kind,
      // timestamp, content, parent_message_hash, batch_ref, …
      const batchRef = String(params[8]);
      this.twitterRows.push({ messageId, batchRef });
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
  constructor(public readonly ens: string | null = null) {}
  async resolve(): Promise<{ ens: string | null }> {
    return { ens: this.ens };
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
    enrichers: opts.enrichers ?? new FakeEnricherPool('ace.eth'),
    logger: (e) => opts.events?.push({ event: e.event, handler: e.handler }),
    batchSize: 100,
  };
}

describe('tick — forward pass', () => {
  it('projects every confirmed row and advances the cursor monotonically', async () => {
    const bytesA = encodePostReplyContents(TWITTER_TAG, { kind: 'post', timestamp: 1, content: 'a' });
    const bytesB = encodePostReplyContents(TWITTER_TAG, { kind: 'post', timestamp: 2, content: 'b' });
    const source = new FakeSource([row(1, bytesA), row(2, bytesB)]);
    const client = new FakeClient();
    const pool = new FakePool(client);
    const events: Array<{ event: string; handler?: string }> = [];
    const result = await tick(
      makeTickOpts({ source: source as never, pool, events })
    );
    expect(result.byHandler.twitter.projected).toBe(2);
    expect(result.byHandler.twitter.skippedDecode).toBe(0);
    // Both rows landed in twitter.posts
    expect(client.twitterRows).toHaveLength(2);
    // Cursor advanced to the last row's chain coord
    expect(client.cursorRow?.last_block_number).toBe(String(102));
    expect(client.cursorRow?.last_tx_index).toBe(String(2));
  });

  it('skips malformed payloads but advances the cursor past them', async () => {
    const good = encodePostReplyContents(TWITTER_TAG, { kind: 'post', timestamp: 1, content: 'a' });
    const bad = new Uint8Array(5); // too short
    const source = new FakeSource([row(1, bad), row(2, good)]);
    const client = new FakeClient();
    const pool = new FakePool(client);
    const result = await tick(makeTickOpts({ source: source as never, pool }));
    expect(result.byHandler.twitter.skippedDecode).toBe(1);
    expect(result.byHandler.twitter.projected).toBe(1);
    expect(client.twitterRows).toHaveLength(1);
    // Cursor still advances past the malformed row + the good row.
    expect(client.cursorRow?.last_block_number).toBe(String(102));
  });

  it('does NOT advance the cursor when project itself throws', async () => {
    const good = encodePostReplyContents(TWITTER_TAG, { kind: 'post', timestamp: 1, content: 'a' });
    const source = new FakeSource([row(1, good)]);
    const client = new FakeClient();
    client.shouldFailProject = true;
    const pool = new FakePool(client);
    const result = await tick(makeTickOpts({ source: source as never, pool }));
    expect(result.byHandler.twitter.skippedConflict).toBe(1);
    expect(result.byHandler.twitter.projected).toBe(0);
    // Cursor was seeded at -1/-1/-1; nothing should have advanced it.
    expect(client.cursorRow?.last_block_number).toBe(String(-1));
  });

  it('stops at first project failure; later rows are not processed and cursor stays put', async () => {
    const a = encodePostReplyContents(TWITTER_TAG, { kind: 'post', timestamp: 1, content: 'a' });
    const b = encodePostReplyContents(TWITTER_TAG, { kind: 'post', timestamp: 2, content: 'b' });
    const source = new FakeSource([row(1, a), row(2, b)]);
    const client = new FakeClient();
    client.projectFailFirst = 1; // first INSERT throws, second would succeed
    const pool = new FakePool(client);
    const result = await tick(makeTickOpts({ source: source as never, pool }));
    expect(result.byHandler.twitter.skippedConflict).toBe(1);
    expect(result.byHandler.twitter.projected).toBe(0);
    expect(client.twitterRows).toHaveLength(0);
    // Cursor MUST still be at genesis so the next tick re-pulls both rows.
    expect(client.cursorRow?.last_block_number).toBe(String(-1));
    expect(client.cursorRow?.last_tx_index).toBe(String(-1));
  });
});

describe('tick — reorg pass', () => {
  it('calls onReorg for each reorged batch and bumps the reorg cursor', async () => {
    const good = encodePostReplyContents(TWITTER_TAG, { kind: 'post', timestamp: 1, content: 'a' });
    const source = new FakeSource(
      [row(1, good)],
      [
        { txHash: TX_HASH, invalidatedAt: 1000 },
      ]
    );
    const client = new FakeClient();
    const pool = new FakePool(client);
    const result = await tick(makeTickOpts({ source: source as never, pool }));
    expect(result.byHandler.twitter.reorged).toBe(1);
    expect(client.twitterRows).toHaveLength(0); // forward projected then reorg dropped
    expect(client.cursorRow?.last_reorg_invalidated_at).toBe(String(1000));
  });

  it('older reorgs (already cursored) are not replayed', async () => {
    const source = new FakeSource(
      [],
      [{ txHash: TX_HASH, invalidatedAt: 500 }]
    );
    const client = new FakeClient();
    // Pre-seed cursor past the reorg.
    client.cursorRow = {
      handler_name: 'twitter',
      handler_version: 1,
      last_block_number: String(100),
      last_tx_index: String(0),
      last_msg_index: String(0),
      last_reorg_invalidated_at: String(1000),
      updated_at: String(Date.now()),
    };
    const pool = new FakePool(client);
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
    const result = await tick(makeTickOpts({ source: source as never, pool }));
    expect(result.byHandler.twitter.reorged).toBe(0);
    // Reorg cursor must stay at genesis (-1) so the next tick re-pulls both.
    expect(client.cursorRow?.last_reorg_invalidated_at).toBe(String(-1));
  });
});
