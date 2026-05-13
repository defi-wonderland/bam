/**
 * Twitter handler unit tests against a recording fake `PoolClient`.
 *
 * Covers:
 *  - decode happy path (post + reply round-trip)
 *  - decode null on malformed input (string instead of bytes, etc.)
 *  - project emits the expected INSERT with the canonical column
 *    order and lowercases hex inputs
 *  - project refuses confirmed rows missing chain coord
 *  - onReorg deletes by batch_ref
 *  - migrate runs the expected DDL set
 */

import { describe, expect, it } from 'vitest';
import { encodeTwitterContents } from 'bam-app-codecs/twitter';
import type { Address, Bytes32 } from 'bam-sdk';
import type { MessageRow } from 'bam-store';

import {
  twitterHandler,
  TWITTER_TAG,
} from '../../src/handlers/twitter/handler.js';
import { TWITTER_DDL } from '../../src/handlers/twitter/schema.js';

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

describe('twitterHandler.decode', () => {
  it('round-trips a post payload', () => {
    const bytes = encodeTwitterContents(TWITTER_TAG, {
      kind: 'post',
      timestamp: 1700,
      content: 'hello',
    });
    const decoded = twitterHandler.decode(bytes);
    expect(decoded).toEqual({ kind: 'post', timestamp: 1700, content: 'hello' });
  });

  it('round-trips a reply payload', () => {
    const bytes = encodeTwitterContents(TWITTER_TAG, {
      kind: 'reply',
      timestamp: 1700,
      parentMessageHash: PARENT_HASH,
      content: 'reply',
    });
    const decoded = twitterHandler.decode(bytes);
    expect(decoded?.kind).toBe('reply');
    expect((decoded as { content: string }).content).toBe('reply');
  });

  it('returns null on truncated input rather than throwing', () => {
    const bytes = new Uint8Array(10);
    expect(twitterHandler.decode(bytes)).toBeNull();
  });
});

describe('twitterHandler.migrate', () => {
  it('runs the documented DDL set', async () => {
    const c = new FakeClient();
    await twitterHandler.migrate(c as never);
    expect(c.queries).toHaveLength(TWITTER_DDL.length);
    for (let i = 0; i < TWITTER_DDL.length; i++) {
      expect(c.queries[i].sql).toBe(TWITTER_DDL[i]);
    }
  });
});

describe('twitterHandler.project', () => {
  it('inserts a post row with lowercased hex and resolved ENS', async () => {
    const bytes = encodeTwitterContents(TWITTER_TAG, {
      kind: 'post',
      timestamp: 9001,
      content: 'gm',
    });
    const row = confirmedRow({ contents: bytes });
    const c = new FakeClient();
    await twitterHandler.project(
      row,
      { kind: 'post', timestamp: 9001, content: 'gm' },
      { ens: 'ace.eth' },
      c as never
    );
    expect(c.queries).toHaveLength(1);
    const q = c.queries[0];
    expect(q.sql).toContain('INSERT INTO');
    expect(q.sql).toContain('twitter.posts');
    expect(q.params).toEqual([
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
      'ace.eth',
    ]);
  });

  it('inserts a reply row with lowercased parent hash', async () => {
    const bytes = encodeTwitterContents(TWITTER_TAG, {
      kind: 'reply',
      timestamp: 9001,
      parentMessageHash: PARENT_HASH,
      content: 're',
    });
    const row = confirmedRow({ contents: bytes });
    const c = new FakeClient();
    await twitterHandler.project(
      row,
      {
        kind: 'reply',
        timestamp: 9001,
        parentMessageHash: PARENT_HASH,
        content: 're',
      },
      { ens: null },
      c as never
    );
    expect(c.queries[0].params[4]).toBe(1); // kind = reply
    expect(c.queries[0].params[7]).toBe(PARENT_HASH.toLowerCase());
    expect(c.queries[0].params[12]).toBeNull(); // ens null
  });

  it('throws when messageId is null (Reader-side bug guard)', async () => {
    const bytes = encodeTwitterContents(TWITTER_TAG, {
      kind: 'post',
      timestamp: 1,
      content: 'x',
    });
    const row = confirmedRow({ contents: bytes, messageId: null });
    const c = new FakeClient();
    await expect(
      twitterHandler.project(
        row,
        { kind: 'post', timestamp: 1, content: 'x' },
        {},
        c as never
      )
    ).rejects.toThrow(/missing message_id/);
  });

  it('throws when chain coord is incomplete', async () => {
    const bytes = encodeTwitterContents(TWITTER_TAG, {
      kind: 'post',
      timestamp: 1,
      content: 'x',
    });
    const row = confirmedRow({ contents: bytes, blockNumber: null });
    const c = new FakeClient();
    await expect(
      twitterHandler.project(
        row,
        { kind: 'post', timestamp: 1, content: 'x' },
        {},
        c as never
      )
    ).rejects.toThrow(/chain coord/);
  });
});

describe('twitterHandler.onReorg', () => {
  it('deletes by lowercased batch_ref', async () => {
    const c = new FakeClient();
    await twitterHandler.onReorg(TX_HASH, 11155111, c as never);
    expect(c.queries).toHaveLength(1);
    expect(c.queries[0].sql).toMatch(/DELETE FROM twitter\.posts WHERE batch_ref = \$1/);
    expect(c.queries[0].params).toEqual([TX_HASH.toLowerCase()]);
  });
});
