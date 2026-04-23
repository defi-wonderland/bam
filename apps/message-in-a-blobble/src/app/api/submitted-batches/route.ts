import { NextRequest, NextResponse } from 'next/server';

import {
  PosterConfigError,
  PosterUnreachableError,
  getSubmittedBatches,
} from '@/lib/poster-client';
import { MESSAGE_IN_A_BLOBBLE_TAG } from '@/lib/constants';

/**
 * Thin HTTP proxy to the Poster's `GET /submitted-batches`. Defaults
 * the `contentTag` filter to `MESSAGE_IN_A_BLOBBLE_TAG` but respects a
 * caller-supplied override.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const tag = request.nextUrl.searchParams.get('contentTag') ?? MESSAGE_IN_A_BLOBBLE_TAG;
    const limit = request.nextUrl.searchParams.get('limit') ?? undefined;
    const sinceBlock = request.nextUrl.searchParams.get('sinceBlock') ?? undefined;
    const poster = await getSubmittedBatches({
      contentTag: tag,
      limit: limit ? Number(limit) : undefined,
      sinceBlock: sinceBlock ?? undefined,
    });
    return NextResponse.json(poster.body, { status: poster.status });
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
