import { NextResponse } from 'next/server';

import { MESSAGE_IN_A_BLOBBLE_TAG } from '@/lib/constants';
import { listBatches, readerErrorToResponse } from '@/lib/reader-client';

interface Blobble {
  versionedHash: string;
  /**
   * Seconds-since-epoch. Prefers `l1IncludedAtUnixSec` (L1 block
   * timestamp — what the original demo displayed before 005). Falls
   * back to the Poster's `submittedAt` (best-effort wall clock; can
   * drift from L1 inclusion time by minutes). Null only if neither
   * is set, which the UI renders as the L1 block number.
   */
  timestamp: number | null;
  /** L1 type-3 transaction `from` (the entity that paid gas to publish the blob). */
  submitter: string | null;
  txHash: string;
  blockNumber: number;
}

interface ReaderBatchRow {
  txHash: string;
  contentTag: string;
  blobVersionedHash: string;
  blockNumber: number | null;
  submittedAt: number | null;
  l1IncludedAtUnixSec: number | null;
  submitter: string | null;
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
        r.l1IncludedAtUnixSec !== null
          ? r.l1IncludedAtUnixSec
          : r.submittedAt !== null
            ? Math.floor(r.submittedAt / 1000)
            : null,
      submitter: r.submitter,
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
