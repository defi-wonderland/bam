import { NextResponse } from 'next/server';

import { flush, posterErrorToResponse } from '@/lib/poster-client';
import { MESSAGE_IN_A_BLOBBLE_TAG } from '@/lib/constants';

/**
 * Thin HTTP proxy that nudges the Poster's per-tag submission loop
 * via `POST /flush?contentTag=…`. The Poster's submission loop runs
 * autonomously; this endpoint just triggers an immediate tick.
 *
 * Historical note: this route previously contained the inline blob
 * encoder + KZG + `registerBlobBatch` call, including a hand-wired
 * ECDSA signature-registry address. All of that now lives inside
 * `@bam/poster`; the registry address is passed to the Poster via
 * `POSTER_SIGNATURE_REGISTRY` on the Poster's process environment,
 * not here.
 */
export async function POST(): Promise<NextResponse> {
  try {
    const poster = await flush({ contentTag: MESSAGE_IN_A_BLOBBLE_TAG });
    return NextResponse.json(poster.body, { status: poster.status });
  } catch (err) {
    const mapped = posterErrorToResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
