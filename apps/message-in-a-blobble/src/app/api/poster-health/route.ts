import { NextResponse } from 'next/server';

import {
  PosterConfigError,
  PosterUnreachableError,
  getHealth,
} from '@/lib/poster-client';

/**
 * Thin HTTP proxy to the Poster's `GET /health`. Returns the Poster's
 * response verbatim; 502 on unreachable, 500 on missing POSTER_URL.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const poster = await getHealth();
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
