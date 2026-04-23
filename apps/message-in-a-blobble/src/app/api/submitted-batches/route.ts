import { NextRequest, NextResponse } from 'next/server';

import { getSubmittedBatches, posterErrorToResponse } from '@/lib/poster-client';
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
    const mapped = posterErrorToResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
