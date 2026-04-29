import { NextRequest, NextResponse } from 'next/server';

import { getPending, posterErrorToResponse, submitMessage } from '@/lib/poster-client';
import { TWITTER_TAG } from '@/lib/constants';

/**
 * Thin HTTP proxy to the shared Poster, scoped to the bam-twitter
 * contentTag. GET forwards to `/pending`, POST forwards to `/submit`.
 *
 * The contentTag on the forwarded envelope is **always** TWITTER_TAG —
 * a client-supplied tag is ignored. The signed `contents` already carry
 * the tag in `contents[0..32]`, and the Poster enforces
 * `envelope.contentTag === contents[0..32]`, so a wrong tag would be
 * rejected upstream anyway. Pinning it here makes per-app isolation a
 * property of the route, not a property of caller behavior.
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
  const message = parsed && 'message' in parsed ? parsed.message : body;
  const envelope = { contentTag: TWITTER_TAG, message };
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
