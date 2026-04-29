import { NextRequest, NextResponse } from 'next/server';

import { MESSAGE_IN_A_BLOBBLE_TAG } from '@/lib/constants';
import { decodeSocialContents } from '@/lib/contents-codec';
import {
  getBatch,
  listConfirmedMessages,
  readerErrorToResponse,
} from '@/lib/reader-client';

interface SnapshotEntry {
  author: string;
  nonce: string;
  messageId: string;
  messageIndexWithinBatch: number;
  messageHash: string;
}

interface ReaderBatch {
  txHash: string;
  blockNumber: number | null;
  blobVersionedHash: string;
  submitter: string | null;
  l1IncludedAtUnixSec: number | null;
  messageSnapshot: SnapshotEntry[];
}

interface ReaderMessage {
  author: string;
  nonce: string;
  contents: string;
  batchRef: string | null;
  messageIndexWithinBatch: number | null;
}

interface DecodedMessage {
  sender: string;
  content: string | null;
  timestamp: number | null;
  nonce: string;
}

function hexToBytes(hex: string): Uint8Array {
  const c = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (c.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(c)) {
    throw new Error('invalid hex');
  }
  const out = new Uint8Array(c.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function safeDecode(contentsHex: string): { timestamp: number; content: string } | null {
  try {
    const { app } = decodeSocialContents(hexToBytes(contentsHex));
    return app;
  } catch {
    return null;
  }
}

/**
 * Detail view for a single confirmed batch. Two Reader calls in
 * parallel: one for the batch row (gives `blobVersionedHash`,
 * `blockNumber`, ordering via `messageSnapshot`), one for the
 * messages attached to that batch (gives the payload bytes that
 * decode into rendered text).
 *
 * `messageSnapshot` alone would let us render authors and nonces
 * but no `content` text — the snapshot does not carry payload
 * bytes. The matching `MessageRow.contents` field does, so we
 * fetch and merge.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ txHash: string }> }
): Promise<NextResponse> {
  try {
    const { txHash } = await params;

    const [batchRes, messagesRes] = await Promise.all([
      getBatch(txHash),
      listConfirmedMessages({
        contentTag: MESSAGE_IN_A_BLOBBLE_TAG,
        // Confirmed-only — never attach payload from a non-confirmed
        // row to a confirmed batch's snapshot entry.
        status: 'confirmed',
        batchRef: txHash,
      }),
    ]);

    // Forward upstream non-200 verbatim — same convention as the
    // confirmed-messages and blobbles list routes. The Reader's 404
    // body is `{ error: 'not_found' }`. Both calls are checked: a
    // 5xx on the messages call must not be hidden behind a successful
    // batch fetch (it would render as `content: null` for every row,
    // masking the upstream failure).
    if (batchRes.status !== 200) {
      return NextResponse.json(batchRes.body, { status: batchRes.status });
    }
    if (messagesRes.status !== 200) {
      return NextResponse.json(messagesRes.body, { status: messagesRes.status });
    }
    const batch = (batchRes.body as { batch?: ReaderBatch }).batch;
    if (!batch) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    // Build a (author,nonce) → MessageRow lookup so we can attach
    // payload bytes to each snapshot entry. An empty 200 from
    // `/messages` is "snapshot has identity but payload bytes weren't
    // observed yet" — render with null content rather than 404.
    const byKey = new Map<string, ReaderMessage>();
    {
      const rows =
        (messagesRes.body as { messages?: ReaderMessage[] }).messages ?? [];
      for (const m of rows) {
        byKey.set(`${m.author.toLowerCase()}:${m.nonce}`, m);
      }
    }

    const messages: DecodedMessage[] = batch.messageSnapshot
      .slice()
      .sort((a, b) => a.messageIndexWithinBatch - b.messageIndexWithinBatch)
      .map((entry) => {
        const match = byKey.get(`${entry.author.toLowerCase()}:${entry.nonce}`);
        const decoded = match ? safeDecode(match.contents) : null;
        return {
          sender: entry.author,
          nonce: entry.nonce,
          timestamp: decoded?.timestamp ?? null,
          content: decoded?.content ?? null,
        };
      });

    return NextResponse.json({
      txHash: batch.txHash,
      blockNumber: batch.blockNumber ?? 0,
      blobVersionedHashes: [batch.blobVersionedHash],
      submitter: batch.submitter,
      l1IncludedAtUnixSec: batch.l1IncludedAtUnixSec,
      messageCount: messages.length,
      messages,
    });
  } catch (err) {
    const mapped = readerErrorToResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
