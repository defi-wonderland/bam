import { NextRequest, NextResponse } from 'next/server';

import { getPending, posterErrorToResponse, submitMessage } from '@/lib/poster-client';
import { MESSAGE_IN_A_BLOBBLE_TAG } from '@/lib/constants';

/**
 * Thin HTTP proxy to the Poster (feature 001-bam-poster, plan §Architecture).
 * GET forwards to the Poster's `/pending` (the demo treats pending as the
 * Poster's truth; confirmed messages are served by the sync indexer via
 * a separate read surface — see `api/submitted-batches/route.ts`).
 * POST wraps the request body in the Poster's envelope shape and
 * forwards to `/submit`, returning the Poster's response verbatim.
 */

export async function GET(): Promise<NextResponse> {
  try {
    const poster = await getPending({ contentTag: MESSAGE_IN_A_BLOBBLE_TAG });
    return NextResponse.json(poster.body, { status: poster.status });
  } catch (err) {
    const mapped = posterErrorToResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // Invalid JSON → controlled 400 instead of an unhandled 500.
    return NextResponse.json(
      { accepted: false, reason: 'malformed' },
      { status: 400 }
    );
  }
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
    const mapped = posterErrorToResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
