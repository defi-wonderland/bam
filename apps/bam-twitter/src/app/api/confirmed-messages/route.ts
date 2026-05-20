import { NextResponse } from 'next/server';

import { TWITTER_TAG } from '@/lib/constants';
import type { ConfirmedRow } from '@/lib/confirmed-row';
import {
  indexerErrorToResponse,
  indexerUrlIfConfigured,
  listTwitterPosts,
  type TwitterPostRow,
} from '@/lib/indexer-client';
import {
  listConfirmedMessages,
  readerErrorToResponse,
} from '@/lib/reader-client';

/**
 * Read surface for confirmed messages. Two paths:
 *
 *   1. **Preferred** — `bam-indexer` at `INDEXER_URL`. The indexer
 *      decodes the Twitter payload server-side and ships
 *      `TwitterPost` rows with `timestamp`, `content`, and ENS
 *      pre-resolved. The wire shape we return here is enriched: it
 *      includes the legacy fields the browser timeline expects
 *      (`message_id`, `sender`, `nonce`, `tx_hash`, `block_number`)
 *      plus the decoded payload fields the browser would otherwise
 *      derive.
 *
 *   2. **Fallback** — `bam-reader` at `READER_URL`. Identical to the
 *      pre-indexer wire shape: `contents` ships as hex; the browser
 *      decodes in `safeDecode`. Engaged when `INDEXER_URL` is unset
 *      OR when the indexer round-trip fails (502).
 *
 * The fallback is the constitution-mandated "degraded mode" — the
 * Reader is the only required dependency; the indexer is a richer
 * cache on top. The unified wire shape is `ConfirmedRow` from
 * `@/lib/confirmed-row` — single source of truth for this endpoint's
 * contract.
 */

interface ReaderMessageRow {
  messageId: string | null;
  sender: string;
  nonce: string;
  contentTag: string;
  contents: string;
  signature: string;
  messageHash: string;
  status: string;
  batchRef: string | null;
  blockNumber: number | null;
}

function fromIndexer(row: TwitterPostRow): ConfirmedRow {
  return {
    message_id: row.message_hash,
    sender: row.sender,
    nonce: row.nonce,
    tx_hash: row.batch_ref,
    block_number: row.block_number,
    status: 'posted',
    timestamp: row.timestamp,
    content: row.content,
    parent_message_hash: row.parent_message_hash,
    kind: row.kind,
  };
}

async function tryIndexer(): Promise<ConfirmedRow[] | null> {
  if (indexerUrlIfConfigured() === null) return null;
  try {
    const res = await listTwitterPosts({ limit: 100 });
    if (res.status !== 200) {
      return null;
    }
    const posts = (res.body as { posts?: TwitterPostRow[] }).posts ?? [];
    return posts.map(fromIndexer);
  } catch (err) {
    const mapped = indexerErrorToResponse(err);
    if (mapped !== null) {
      // Indexer is configured but unreachable — log to stderr (Next
      // server console) and let the Reader fallback below take over.
      // We do NOT propagate the indexer error to the client because
      // the Reader path can still answer the request.
      console.warn(
        `[bam-twitter] /api/confirmed-messages: indexer unreachable, falling back to Reader`
      );
      return null;
    }
    throw err;
  }
}

async function fromReader(): Promise<NextResponse> {
  try {
    const res = await listConfirmedMessages({
      contentTag: TWITTER_TAG,
      status: 'confirmed',
    });
    if (res.status !== 200) {
      return NextResponse.json(res.body, { status: res.status });
    }
    const rows = (res.body as { messages?: ReaderMessageRow[] }).messages ?? [];
    const messages: ConfirmedRow[] = rows.flatMap((r) => {
      if (r.batchRef === null) return [];
      return [
        {
          message_id: r.messageHash,
          sender: r.sender,
          nonce: r.nonce,
          contents: r.contents,
          signature: r.signature,
          tx_hash: r.batchRef,
          block_number: r.blockNumber,
          status: 'posted' as const,
        },
      ];
    });
    return NextResponse.json({ messages });
  } catch (err) {
    const mapped = readerErrorToResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function GET(): Promise<NextResponse> {
  const indexed = await tryIndexer();
  if (indexed !== null) {
    return NextResponse.json({ messages: indexed });
  }
  return await fromReader();
}
