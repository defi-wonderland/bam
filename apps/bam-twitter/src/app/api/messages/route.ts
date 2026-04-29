import { NextRequest, NextResponse } from 'next/server';

import { getPending, posterErrorToResponse, submitMessage } from '@/lib/poster-client';
import { TWITTER_TAG } from '@/lib/constants';

/**
 * Thin HTTP proxy to the shared Poster, scoped to the bam-twitter
 * contentTag. GET forwards to `/pending`, POST forwards to `/submit`
 * after backfilling the contentTag (the Poster rejects envelopes
 * without one).
 */

export async function GET(): Promise<NextResponse> {
  try {
    const poster = await getPending({ contentTag: TWITTER_TAG });
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
    return NextResponse.json(
      { accepted: false, reason: 'malformed' },
      { status: 400 }
    );
  }
  const parsed =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  const envelope =
    parsed && 'message' in parsed
      ? {
          contentTag:
            typeof parsed.contentTag === 'string'
              ? parsed.contentTag
              : TWITTER_TAG,
          message: parsed.message,
        }
      : { contentTag: TWITTER_TAG, message: body };
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
