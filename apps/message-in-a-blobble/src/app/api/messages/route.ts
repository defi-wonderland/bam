import { NextRequest, NextResponse } from 'next/server';

import {
  PosterConfigError,
  PosterUnreachableError,
  getPending,
  submitMessage,
} from '@/lib/poster-client';
import { MESSAGE_IN_A_BLOBBLE_TAG } from '@/lib/constants';

/**
 * Thin HTTP proxy to the Poster (feature 001-bam-poster, plan §Architecture).
 * GET forwards to the Poster's `/pending` (the demo treats pending as the
 * Poster's truth; confirmed messages are served by the sync indexer via
 * a separate read surface — see `api/submitted-batches/route.ts`).
 * POST wraps the request body in the Poster's envelope shape and
 * forwards to `/submit`, returning the Poster's response verbatim.
 */

function unreachable(): NextResponse {
  return NextResponse.json(
    { error: 'poster_unreachable', detail: 'POSTER_URL not reachable' },
    { status: 502 }
  );
}

function misconfigured(): NextResponse {
  return NextResponse.json(
    { error: 'poster_url_not_configured', detail: 'POSTER_URL env var is required' },
    { status: 500 }
  );
}

export async function GET(): Promise<NextResponse> {
  try {
    const poster = await getPending({ contentTag: MESSAGE_IN_A_BLOBBLE_TAG });
    return NextResponse.json(poster.body, { status: poster.status });
  } catch (err) {
    if (err instanceof PosterUnreachableError) return unreachable();
    if (err instanceof PosterConfigError) return misconfigured();
    throw err;
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.json();
  const envelope = {
    contentTag: MESSAGE_IN_A_BLOBBLE_TAG,
    message: body,
  };
  try {
    const poster = await submitMessage({
      rawEnvelope: new TextEncoder().encode(JSON.stringify(envelope)),
    });
    return NextResponse.json(poster.body, { status: poster.status });
  } catch (err) {
    if (err instanceof PosterUnreachableError) return unreachable();
    if (err instanceof PosterConfigError) return misconfigured();
    throw err;
  }
}
