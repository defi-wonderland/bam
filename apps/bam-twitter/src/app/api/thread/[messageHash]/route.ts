import { NextRequest, NextResponse } from 'next/server';

import { TWITTER_TAG } from '@/lib/constants';
import type { ConfirmedRow } from '@/lib/confirmed-row';
import {
  indexerUrlIfConfigured,
  getTwitterPostByHash,
  listTwitterReplies,
  type TwitterPostRow,
} from '@/lib/indexer-client';
import {
  listConfirmedMessages,
  readerErrorToResponse,
} from '@/lib/reader-client';

const HEX_BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

class ReaderHttpError extends Error {
  constructor(public readonly readerStatus: number) {
    super(`Reader returned ${readerStatus}`);
  }
}

function fromIndexerRow(row: TwitterPostRow): ConfirmedRow {
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

async function tryIndexer(
  messageHash: string,
): Promise<{ post: ConfirmedRow; replies: ConfirmedRow[] } | null> {
  if (indexerUrlIfConfigured() === null) return null;
  try {
    const [postRes, repliesRes] = await Promise.all([
      getTwitterPostByHash({ messageHash }),
      listTwitterReplies({ parentMessageHash: messageHash }),
    ]);
    if (postRes.status === 404) return null;
    if (postRes.status !== 200) return null;
    const postRow = (postRes.body as { post?: TwitterPostRow }).post;
    if (!postRow) return null;
    if (repliesRes.status !== 200) {
      console.warn(`[bam-twitter] /api/thread: replies fetch returned ${repliesRes.status}, returning post without replies`);
      return { post: fromIndexerRow(postRow), replies: [] };
    }
    const replies = (repliesRes.body as { replies?: TwitterPostRow[] }).replies ?? [];
    return { post: fromIndexerRow(postRow), replies: replies.map(fromIndexerRow) };
  } catch {
    console.warn('[bam-twitter] /api/thread: indexer unreachable, falling back to Reader');
    return null;
  }
}

interface ReaderMessageRow {
  messageHash: string;
  sender: string;
  nonce: string;
  contents: string;
  signature: string;
  batchRef: string | null;
  blockNumber: number | null;
}

function hexToBytes(hex: string): Uint8Array {
  const c = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(c.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function fromReader(
  messageHash: string,
): Promise<{ post: ConfirmedRow; replies: ConfirmedRow[] } | null> {
  const res = await listConfirmedMessages({ contentTag: TWITTER_TAG, status: 'confirmed', limit: 1000 });
  if (res.status !== 200) {
    throw new ReaderHttpError(res.status);
  }
  const rows = (res.body as { messages?: ReaderMessageRow[] }).messages ?? [];

  const { decodePostReplyContents } = await import('bam-sdk/post-reply');

  let post: ConfirmedRow | null = null;
  const replies: ConfirmedRow[] = [];

  for (const r of rows) {
    if (!r.batchRef) continue;
    let decoded: { timestamp: number; content: string; kind: 'post' | 'reply'; parentMessageHash?: string } | null = null;
    try {
      const app = decodePostReplyContents(hexToBytes(r.contents));
      decoded = {
        timestamp: app.timestamp,
        content: app.content,
        kind: app.kind,
        parentMessageHash: app.kind === 'reply' ? app.parentMessageHash : undefined,
      };
    } catch {
      continue;
    }

    const row: ConfirmedRow = {
      message_id: r.messageHash,
      sender: r.sender,
      nonce: r.nonce,
      contents: r.contents,
      signature: r.signature,
      tx_hash: r.batchRef,
      block_number: r.blockNumber,
      status: 'posted',
      timestamp: decoded.timestamp,
      content: decoded.content,
      parent_message_hash: decoded.parentMessageHash ?? null,
      kind: decoded.kind,
    };

    if (r.messageHash.toLowerCase() === messageHash.toLowerCase()) {
      post = row;
    } else if (decoded.kind === 'reply' && decoded.parentMessageHash?.toLowerCase() === messageHash.toLowerCase()) {
      replies.push(row);
    }
  }

  if (!post) return null;
  replies.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  return { post, replies };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ messageHash: string }> },
): Promise<NextResponse> {
  const { messageHash } = await params;
  if (!HEX_BYTES32_RE.test(messageHash)) {
    return NextResponse.json({ error: 'bad_request', reason: 'messageHash' }, { status: 400 });
  }

  const indexed = await tryIndexer(messageHash);
  if (indexed !== null) return NextResponse.json(indexed);

  try {
    const result = await fromReader(messageHash);
    if (!result) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ReaderHttpError) {
      return NextResponse.json({ error: 'reader_error', status: err.readerStatus }, { status: 502 });
    }
    const mapped = readerErrorToResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
