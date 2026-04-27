import { NextResponse } from 'next/server';

import { getBamStore } from '@/lib/bam-store-client';
import { MESSAGE_IN_A_BLOBBLE_TAG } from '@/lib/constants';

/**
 * Read surface for **confirmed** messages — sourced from the shared
 * `bam-store` substrate (populated by the Reader, and optionally by a
 * co-located Poster). Each row carries `{ sender, nonce, contents:
 * hex, signature, messageHash, messageId }`. `contents` is left
 * opaque at this boundary — the client side (`lib/messages.ts` +
 * `contents-codec.ts`) decodes it for display.
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

function bytesToHex(bytes: Uint8Array): string {
  let out = '0x';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export async function GET(): Promise<NextResponse> {
  try {
    const store = getBamStore();
    const rows = await store.withTxn(async (txn) =>
      txn.listMessages({
        contentTag: MESSAGE_IN_A_BLOBBLE_TAG,
        status: 'confirmed',
      })
    );

    // Substrate invariant: a `confirmed` MessageRow always has a
    // non-null `batchRef` (points to the BatchRow it landed in). Drop
    // any row that violates this rather than synthesising a placeholder
    // hash for the UI.
    const messages: ConfirmedRow[] = rows.flatMap((r) => {
      if (r.batchRef === null) return [];
      const txHash = r.batchRef;
      const id = r.messageId ?? r.messageHash;
      // `blobbleId` was a substring of the blobVersionedHash; the
      // Reader writes the same `batchRef = txHash`, and the BatchRow's
      // `blobVersionedHash` is unavailable directly on a MessageRow,
      // so use the txHash prefix as the stable ID instead. Equivalent
      // length / role for the UI.
      const blobbleId = txHash.slice(0, 18);
      return [
        {
          message_id: id,
          sender: r.author,
          nonce: String(r.nonce),
          contents: bytesToHex(r.contents),
          signature: bytesToHex(r.signature),
          tx_hash: txHash,
          block_number: r.blockNumber,
          blobble_id: blobbleId,
          status: 'posted',
        },
      ];
    });

    return NextResponse.json({ messages });
  } catch (err) {
    // Log the underlying detail server-side; clients only get the
    // generic code so we don't leak DSN strings, schema hints, or
    // stack traces into the response body.
    console.error('[confirmed-messages] bam_store_unreachable:', err);
    return NextResponse.json(
      { error: 'bam_store_unreachable' },
      { status: 502 }
    );
  }
}
