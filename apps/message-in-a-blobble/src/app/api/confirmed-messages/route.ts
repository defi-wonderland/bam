import { NextResponse } from 'next/server';

import { MESSAGE_IN_A_BLOBBLE_TAG } from '@/lib/constants';
import {
  listConfirmedMessages,
  readerErrorToResponse,
} from '@/lib/reader-client';

/**
 * Read surface for **confirmed** messages — sourced from the Reader's
 * `GET /messages` endpoint over HTTP. The wire shape exposed to the
 * browser (`{ messages: ConfirmedRow[] }`) is held constant; the
 * Reader returns generic `bam-store` rows (with `bigint` stringified
 * and bytea fields rendered as `0x`-prefixed hex), and this route
 * reshapes them.
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
      contentTag: MESSAGE_IN_A_BLOBBLE_TAG,
      status: 'confirmed',
    });
    if (res.status !== 200) {
      // Forward the Reader's error verbatim so a 4xx/5xx from the
      // upstream stays visible to the client (parallel to the Poster
      // proxy pattern).
      return NextResponse.json(res.body, { status: res.status });
    }
    const rows = (res.body as { messages?: ReaderMessageRow[] }).messages ?? [];

    // Substrate invariant: a `confirmed` MessageRow always has a
    // non-null `batchRef` (points to the BatchRow it landed in). Drop
    // any row that violates this rather than synthesising a placeholder
    // hash for the UI.
    const messages: ConfirmedRow[] = rows.flatMap((r) => {
      if (r.batchRef === null) return [];
      const txHash = r.batchRef;
      const id = r.messageId ?? r.messageHash;
      return [
        {
          message_id: id,
          sender: r.author,
          nonce: r.nonce,
          contents: r.contents,
          signature: r.signature,
          tx_hash: txHash,
          block_number: r.blockNumber,
          blobble_id: txHash.slice(0, 18),
          status: 'posted',
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
