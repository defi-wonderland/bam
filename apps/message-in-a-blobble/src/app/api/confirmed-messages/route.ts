import { NextResponse } from 'next/server';

import {
  PosterConfigError,
  PosterUnreachableError,
  getSubmittedBatches,
} from '@/lib/poster-client';
import { MESSAGE_IN_A_BLOBBLE_TAG } from '@/lib/constants';

/**
 * Read surface for **confirmed** messages — flattened from the
 * Poster's `/submitted-batches`. The Poster stores full decoded
 * message bodies on every submitted batch (for the reorg watcher's
 * re-enqueue path), so the UI can render "posted" messages directly
 * from this single source of truth without re-fetching blobs from
 * the beacon API or depending on a sync-indexer cold-start pass.
 *
 * Returned shape mirrors the pre-migration DbMessage rows the UI
 * used to expect — same field names, plus the batch-level metadata
 * clients need to render etherscan links (tx_hash, block_number).
 */
interface ConfirmedRow {
  message_id: string;
  author: string;
  timestamp: number;
  nonce: number;
  content: string;
  tx_hash: string;
  block_number: number | null;
  blobble_id: string;
  status: 'posted';
}

interface BatchFromPoster {
  txHash: string;
  contentTag: string;
  blobVersionedHash: string;
  blockNumber: number | null;
  status: string;
  replacedByTxHash: string | null;
  submittedAt: number;
  messages: Array<{
    messageId: string;
    author: string;
    nonce: string | number;
    timestamp: number;
    content: string;
    signature: string;
  }>;
}

export async function GET(): Promise<NextResponse> {
  try {
    const poster = await getSubmittedBatches({
      contentTag: MESSAGE_IN_A_BLOBBLE_TAG,
    });
    if (poster.status !== 200) {
      return NextResponse.json(poster.body, { status: poster.status });
    }
    const { batches = [] } = (poster.body ?? {}) as { batches?: BatchFromPoster[] };

    const messages: ConfirmedRow[] = [];
    for (const b of batches) {
      // Skip reorged-out batches; their messages get re-enqueued
      // and reappear under a different txHash once resubmitted.
      if (b.status === 'reorged') continue;
      const blobbleId = b.blobVersionedHash.slice(0, 18);
      for (const m of b.messages) {
        messages.push({
          message_id: m.messageId,
          author: m.author,
          timestamp: m.timestamp,
          nonce: typeof m.nonce === 'string' ? Number(m.nonce) : m.nonce,
          content: m.content,
          tx_hash: b.txHash,
          block_number: b.blockNumber,
          blobble_id: blobbleId,
          status: 'posted',
        });
      }
    }

    return NextResponse.json({ messages });
  } catch (err) {
    if (err instanceof PosterUnreachableError) {
      return NextResponse.json(
        { error: 'poster_unreachable', detail: 'POSTER_URL not reachable' },
        { status: 502 }
      );
    }
    if (err instanceof PosterConfigError) {
      return NextResponse.json(
        { error: 'poster_url_not_configured' },
        { status: 500 }
      );
    }
    throw err;
  }
}
