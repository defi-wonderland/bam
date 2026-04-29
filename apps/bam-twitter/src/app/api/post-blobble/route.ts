import { NextResponse } from 'next/server';

import { flush, posterErrorToResponse } from '@/lib/poster-client';
import { TWITTER_TAG } from '@/lib/constants';

/**
 * Thin HTTP proxy that nudges the shared Poster's per-tag submission
 * loop via `POST /flush?contentTag=…`. The submission loop runs
 * autonomously; this endpoint just triggers an immediate tick for
 * the bam-twitter feed so a freshly-signed post lands on-chain
 * without waiting for the next cycle.
 */
export async function POST(): Promise<NextResponse> {
  try {
    const poster = await flush({ contentTag: TWITTER_TAG });
    return NextResponse.json(poster.body, { status: poster.status });
  } catch (err) {
    const mapped = posterErrorToResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
