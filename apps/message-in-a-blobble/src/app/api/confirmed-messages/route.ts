import { NextResponse } from 'next/server';

import { getSubmittedBatches, posterErrorToResponse } from '@/lib/poster-client';
import { MESSAGE_IN_A_BLOBBLE_TAG } from '@/lib/constants';

/**
 * Read surface for **confirmed** messages — flattened from the
 * Poster's `/submitted-batches`.
 *
 * Each submitted-batch entry's `messages` carries `{ sender, nonce,
 * contents: hex, signature, messageHash, messageId }`. `contents` is
 * left opaque at this boundary — the client side (`lib/messages.ts` +
 * `contents-codec.ts`) decodes it into `{ timestamp, content }` for
 * display. Keeping the codec single-sourced on the client avoids
 * codec drift between composer and reader.
 */
interface ConfirmedRow {
  message_id: string;
  sender: string;
  nonce: string;
  contents: string; // 0x-prefixed hex; first 32 bytes are the contentTag
  signature: string;
  tx_hash: string;
  block_number: number | null;
  blobble_id: string;
  status: 'posted';
}

interface BatchFromPoster {
  txHash: string;
  contentTag: string;
  blobVersionedHash: string;
  batchContentHash: string;
  blockNumber: number | null;
  status: string;
  replacedByTxHash: string | null;
  submittedAt: number;
  invalidatedAt: number | null;
  messages: Array<{
    sender: string;
    nonce: string | number;
    contents: string;
    signature: string;
    messageHash: string;
    messageId: string | null;
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
      if (b.status !== 'included') continue;
      const blobbleId = b.blobVersionedHash.slice(0, 18);
      for (const m of b.messages) {
        // Batch-scoped `messageId` is guaranteed non-null when
        // status === 'included'; fall back to `messageHash` if for
        // any reason it's missing, so the UI still has a stable key.
        const id = m.messageId ?? m.messageHash;
        messages.push({
          message_id: id,
          sender: m.sender,
          nonce: String(m.nonce),
          contents: m.contents,
          signature: m.signature,
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
