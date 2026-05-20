/**
 * `post-reply` handler unit tests against a recording fake `PoolClient`.
 *
 * The handler is constructed via `createPostReplyHandler` with
 * twitter-shaped opts (`{name:'twitter', schema:'twitter', ...}`) so the
 * SQL and route shape match what bam-twitter sees at runtime.
 *
 * Covers:
 *  - decode happy path (post + reply round-trip)
 *  - decode null on malformed input
 *  - project emits the expected INSERT with canonical column order +
 *    lowercased hex
 *  - project refuses confirmed rows missing chain coord
 *  - onReorg deletes by batch_ref
 *  - migrate runs the expected DDL set
 */

import { describe, expect, it } from 'vitest';
import { encodePostReplyContents } from 'bam-sdk/post-reply';
import type { Address, Bytes32 } from 'bam-sdk';
import type { MessageRow } from 'bam-store';

import { createPostReplyHandler } from '../../src/handlers/post-reply/handler.js';
import { postReplyDdl } from '../../src/handlers/post-reply/schema.js';

const TWITTER_TAG = ('0x' + 'f0'.repeat(32)) as Bytes32;
const handler = createPostReplyHandler({
  name: 'twitter',
  contentTag: TWITTER_TAG,
  schema: 'twitter',
});
const DDL = postReplyDdl('twitter');

interface RecordedQuery {
  sql: string;
  params: unknown[];
}

class FakeClient {
  readonly queries: RecordedQuery[] = [];
  async query(sql: string, params: unknown[] = []): Promise<{ rowCount: number; rows: unknown[] }> {
    this.queries.push({ sql, params });
    return { rowCount: 0, rows: [] };
  }
  release(): void {
    /* noop */
  }
}

const SENDER = ('0x' + 'aa'.repeat(20)) as Address;
const PARENT_HASH = ('0x' + 'bb'.repeat(32)) as Bytes32;
const TX_HASH = ('0x' + 'cc'.repeat(32)) as Bytes32;
const MESSAGE_ID = ('0x' + 'dd'.repeat(32)) as Bytes32;
const MESSAGE_HASH = ('0x' + 'ee'.repeat(32)) as Bytes32;
const VERSION_ID = '00000000-0000-4000-8000-000000000001';

function confirmedRow(overrides: Partial<MessageRow> & { contents: Uint8Array }): MessageRow {
  return {
    messageId: MESSAGE_ID,
    sender: SENDER,
    nonce: 42n,
    contentTag: TWITTER_TAG,
    contents: overrides.contents,
    signature: new Uint8Array(65),
    messageHash: MESSAGE_HASH,
    status: 'confirmed',
    batchRef: TX_HASH,
    chainId: 11155111,
    ingestedAt: null,
    ingestSeq: null,
    blockNumber: 100,
    txIndex: 2,
    messageIndexWithinBatch: 0,
    ...overrides,
  };
}

describe('createPostReplyHandler schema quoting', () => {
  it('quotes the schema in DDL — embedded double-quotes are doubled', async () => {
    const h = createPostReplyHandler({
      name: 'evil',
      contentTag: TWITTER_TAG,
      schema: 'a"b',
    });
    const c = new FakeClient();
    await h.migrate(c as never);
    // Every DDL statement must reference the quoted, escaped schema.
    expect(c.queries.length).toBeGreaterThan(0);
    for (const q of c.queries) {
      expect(q.sql).toContain('"a""b".posts');
      expect(q.sql).not.toMatch(/(^|\s)a"b\./); // never the raw form
    }
  });

  it('accepts schemas that would be invalid unquoted (hyphen, digit-leading)', async () => {
    const hHyphen = createPostReplyHandler({
      name: 'my-app',
      contentTag: TWITTER_TAG,
      schema: 'my-app',
    });
    const hDigit = createPostReplyHandler({
      name: 'x',
      contentTag: TWITTER_TAG,
      schema: '1twitter',
    });
    const c = new FakeClient();
    await hHyphen.onReorg(TX_HASH, 11155111, c as never);
    await hDigit.onReorg(TX_HASH, 11155111, c as never);
    expect(c.queries[0].sql).toContain('"my-app".posts');
    expect(c.queries[1].sql).toContain('"1twitter".posts');
  });

  it('rejects an empty schema (Postgres would error too)', () => {
    expect(() =>
      createPostReplyHandler({
        name: 'x',
        contentTag: TWITTER_TAG,
        schema: '',
      }),
    ).toThrow(/non-empty/);
  });

  it('neutralizes a SQL-metachar injection attempt by quoting it', async () => {
    const h = createPostReplyHandler({
      name: 'evil',
      contentTag: TWITTER_TAG,
      schema: 'twitter; DROP TABLE bam',
    });
    const c = new FakeClient();
    await h.onReorg(TX_HASH, 11155111, c as never);
    // The whole literal sits inside the double-quoted identifier —
    // Postgres parses it as one schema name, not as two statements.
    expect(c.queries[0].sql).toContain('"twitter; DROP TABLE bam".posts');
  });
});

describe('post-reply handler.decode', () => {
  it('round-trips a post payload', () => {
    const bytes = encodePostReplyContents(TWITTER_TAG, {
      kind: 'post',
      timestamp: 1700,
      content: 'hello',
    });
    const decoded = handler.decode(bytes);
    expect(decoded).toEqual({ kind: 'post', timestamp: 1700, content: 'hello' });
  });

  it('round-trips a reply payload', () => {
    const bytes = encodePostReplyContents(TWITTER_TAG, {
      kind: 'reply',
      timestamp: 1700,
      parentMessageHash: PARENT_HASH,
      content: 'reply',
    });
    const decoded = handler.decode(bytes);
    expect(decoded?.kind).toBe('reply');
    expect((decoded as { content: string }).content).toBe('reply');
  });

  it('returns null on truncated input rather than throwing', () => {
    const bytes = new Uint8Array(10);
    expect(handler.decode(bytes)).toBeNull();
  });
});

describe('post-reply handler.migrate', () => {
  it('runs the documented DDL set', async () => {
    const c = new FakeClient();
    await handler.migrate(c as never);
    expect(c.queries).toHaveLength(DDL.length);
    for (let i = 0; i < DDL.length; i++) {
      expect(c.queries[i].sql).toBe(DDL[i]);
    }
  });
});

describe('post-reply handler.project', () => {
  it('inserts a post row with version_id + lowercased hex', async () => {
    const bytes = encodePostReplyContents(TWITTER_TAG, {
      kind: 'post',
      timestamp: 9001,
      content: 'gm',
    });
    const row = confirmedRow({ contents: bytes });
    const c = new FakeClient();
    await handler.project(
      row,
      { kind: 'post', timestamp: 9001, content: 'gm' },
      {},
      c as never,
      VERSION_ID,
    );
    expect(c.queries).toHaveLength(1);
    const q = c.queries[0];
    expect(q.sql).toContain('INSERT INTO');
    expect(q.sql).toContain('"twitter".posts');
    expect(q.params).toEqual([
      VERSION_ID,
      MESSAGE_ID.toLowerCase(),
      MESSAGE_HASH.toLowerCase(),
      SENDER.toLowerCase(),
      '42',
      0, // kind = post
      9001,
      'gm',
      null, // parent_message_hash null on post
      TX_HASH.toLowerCase(),
      100,
      2,
      0,
    ]);
  });

  it('inserts a reply row with lowercased parent hash', async () => {
    const bytes = encodePostReplyContents(TWITTER_TAG, {
      kind: 'reply',
      timestamp: 9001,
      parentMessageHash: PARENT_HASH,
      content: 're',
    });
    const row = confirmedRow({ contents: bytes });
    const c = new FakeClient();
    await handler.project(
      row,
      {
        kind: 'reply',
        timestamp: 9001,
        parentMessageHash: PARENT_HASH,
        content: 're',
      },
      {},
      c as never,
      VERSION_ID,
    );
    expect(c.queries[0].params[0]).toBe(VERSION_ID);
    expect(c.queries[0].params[5]).toBe(1); // kind = reply (shifted by version_id)
    expect(c.queries[0].params[8]).toBe(PARENT_HASH.toLowerCase());
  });

  it('throws when messageId is null (Reader-side bug guard)', async () => {
    const bytes = encodePostReplyContents(TWITTER_TAG, {
      kind: 'post',
      timestamp: 1,
      content: 'x',
    });
    const row = confirmedRow({ contents: bytes, messageId: null });
    const c = new FakeClient();
    await expect(
      handler.project(
        row,
        { kind: 'post', timestamp: 1, content: 'x' },
        {},
        c as never,
        VERSION_ID,
      ),
    ).rejects.toThrow(/missing message_id/);
  });

  it('throws when chain coord is incomplete', async () => {
    const bytes = encodePostReplyContents(TWITTER_TAG, {
      kind: 'post',
      timestamp: 1,
      content: 'x',
    });
    const row = confirmedRow({ contents: bytes, blockNumber: null });
    const c = new FakeClient();
    await expect(
      handler.project(
        row,
        { kind: 'post', timestamp: 1, content: 'x' },
        {},
        c as never,
        VERSION_ID,
      ),
    ).rejects.toThrow(/chain coord/);
  });
});

describe('post-reply handler.onReorg', () => {
  it('deletes by lowercased batch_ref (cascades across versions)', async () => {
    const c = new FakeClient();
    await handler.onReorg(TX_HASH, 11155111, c as never);
    expect(c.queries).toHaveLength(1);
    expect(c.queries[0].sql).toMatch(/DELETE FROM "twitter"\.posts WHERE batch_ref = \$1/);
    expect(c.queries[0].params).toEqual([TX_HASH.toLowerCase()]);
  });
});

describe('post-reply handler.deleteVersion', () => {
  it('deletes by version_id only', async () => {
    const c = new FakeClient();
    await handler.deleteVersion(VERSION_ID, c as never);
    expect(c.queries).toHaveLength(1);
    expect(c.queries[0].sql).toMatch(/DELETE FROM "twitter"\.posts WHERE version_id = \$1/);
    expect(c.queries[0].params).toEqual([VERSION_ID]);
  });
});
