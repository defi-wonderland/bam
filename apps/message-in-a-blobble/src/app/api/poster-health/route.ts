import { NextResponse } from 'next/server';

import { getHealth, posterErrorToResponse } from '@/lib/poster-client';

/**
 * Thin HTTP proxy to the Poster's `GET /health`. Returns the Poster's
 * response verbatim; 502 on unreachable, 500 on missing POSTER_URL.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const poster = await getHealth();
    return NextResponse.json(poster.body, { status: poster.status });
  } catch (err) {
    const mapped = posterErrorToResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
