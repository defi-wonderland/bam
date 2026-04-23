import { NextResponse } from 'next/server';

import { getSubmittedBatches, posterErrorToResponse } from '@/lib/poster-client';
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
  /**
   * Preserved as the decimal string the Poster sends. Casting to
   * JS `number` would silently lose precision for a 20-digit uint64
   * nonce (NEXT_SPEC's widening direction); keeping the string lets
   * clients parse via `BigInt` if they need arithmetic.
   */
  nonce: string;
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
      // Only batches the Poster considers landed-on-canonical-chain
      // are rendered as "posted". `pending` = not yet on chain (edge
      // case — the Poster's submission path only inserts when a
      // receipt is back, but the type allows it). `reorged` = fell
      // out of the canonical chain; messages get re-enqueued and
      // reappear under the replacement batch's txHash.
      if (b.status !== 'included') continue;
      const blobbleId = b.blobVersionedHash.slice(0, 18);
      for (const m of b.messages) {
        messages.push({
          message_id: m.messageId,
          author: m.author,
          timestamp: m.timestamp,
          nonce: String(m.nonce),
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
    const mapped = posterErrorToResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
