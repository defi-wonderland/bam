import { NextRequest, NextResponse } from 'next/server';

import { posterErrorToResponse, submitMessage } from '@/lib/poster-client';
import { FORUM_TAG } from '@/lib/constants';

/**
 * POST `/api/messages` — forwards a signed message envelope to the
 * Poster's `/submit`, with `contentTag` pinned to `FORUM_TAG` server
 * side. The ERC-8180 messageHash formula binds the tag into the signed
 * digest, so a signature authored under a different tag would fail
 * verification at the Poster — pinning here makes per-app isolation a
 * property of the route, not caller behavior.
 *
 * GET is handled by `/api/pending` (which filters by sender) — there's
 * no public "all pending across the forum" view.
 */

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
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('message' in body)) {
    return NextResponse.json(
      { accepted: false, reason: 'malformed' },
      { status: 400 }
    );
  }
  const envelope = {
    contentTag: FORUM_TAG,
    message: (body as { message: unknown }).message,
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
