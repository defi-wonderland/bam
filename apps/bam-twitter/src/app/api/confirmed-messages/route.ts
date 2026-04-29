import { NextResponse } from 'next/server';

import { TWITTER_TAG } from '@/lib/constants';
import {
  listConfirmedMessages,
  readerErrorToResponse,
} from '@/lib/reader-client';

/**
 * Read surface for confirmed messages — sourced from the shared
 * Reader's `GET /messages` endpoint, scoped to the bam-twitter
 * contentTag. The wire shape returned to the browser mirrors the
 * blobble demo so the lib helpers stay shape-stable across apps.
 */
interface ConfirmedRow {
  message_id: string;
  sender: string;
  nonce: string;
  contents: string;
  signature: string;
  tx_hash: string;
  block_number: number | null;
  status: 'posted';
}

interface ReaderMessageRow {
  messageId: string | null;
  author: string;
  nonce: string;
  contentTag: string;
  contents: string;
  signature: string;
  messageHash: string;
  status: string;
  batchRef: string | null;
  blockNumber: number | null;
}

export async function GET(): Promise<NextResponse> {
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
      // Use ERC-8180 messageHash (pre-batch, stable across pending /
      // confirmed) as the client-facing id. Replies bind
      // parentMessageHash, so the Timeline must group on the same
      // identifier — the batch-scoped messageId would orphan replies
      // the moment their parent confirms.
      return [
        {
          message_id: r.messageHash,
          sender: r.author,
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
