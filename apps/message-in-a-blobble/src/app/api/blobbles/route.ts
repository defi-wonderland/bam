import { NextResponse } from 'next/server';

import { MESSAGE_IN_A_BLOBBLE_TAG } from '@/lib/constants';
import { listBatches, readerErrorToResponse } from '@/lib/reader-client';

interface Blobble {
  versionedHash: string;
  // Seconds-since-epoch from the batch's `submittedAt`, when the
  // Poster (or a Poster+Reader co-deploy) writes one. In Reader-only
  // deploys (the demo's case) the Reader doesn't set `submittedAt`,
  // so the field is null and the UI renders the L1 block number
  // instead of synthesising a misleading 1970-01-01 timestamp.
  timestamp: number | null;
  txHash: string;
  blockNumber: number;
}

interface ReaderBatchRow {
  txHash: string;
  contentTag: string;
  blobVersionedHash: string;
  blockNumber: number | null;
  submittedAt: number | null;
  messageSnapshot: Array<{ author: string }>;
}

/**
 * Read path for confirmed batches — proxies to the Reader's
 * `GET /batches` endpoint. The Reader's L1-tailing loop already
 * derived this view from `BlobBatchRegistered` events, so the demo
 * no longer needs to re-query L1 RPC for it. The wire shape exposed
 * to the browser is the legacy `Blobble[]` shape; reshaping happens
 * here so the Reader's HTTP surface stays generic.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const res = await listBatches({
      contentTag: MESSAGE_IN_A_BLOBBLE_TAG,
      status: 'confirmed',
    });
    if (res.status !== 200) {
      return NextResponse.json(res.body, { status: res.status });
    }
    const rows = (res.body as { batches?: ReaderBatchRow[] }).batches ?? [];

    const blobbles: Blobble[] = rows.map((r) => ({
      versionedHash: r.blobVersionedHash,
      timestamp:
        r.submittedAt !== null ? Math.floor(r.submittedAt / 1000) : null,
      txHash: r.txHash,
      blockNumber: r.blockNumber ?? 0,
    }));

    blobbles.sort((a, b) => b.blockNumber - a.blockNumber);

    return NextResponse.json({ blobbles });
  } catch (err) {
    const mapped = readerErrorToResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
