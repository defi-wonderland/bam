import { NextResponse } from 'next/server';

import { getStatus, posterErrorToResponse } from '@/lib/poster-client';

/**
 * Thin HTTP proxy to the Poster's `GET /status`. Returns the Poster's
 * response verbatim.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const poster = await getStatus();
    return NextResponse.json(poster.body, { status: poster.status });
  } catch (err) {
    const mapped = posterErrorToResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
