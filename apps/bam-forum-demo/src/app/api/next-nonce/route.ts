import { NextRequest, NextResponse } from 'next/server';

import { getNextNonce, posterErrorToResponse } from '@/lib/poster-client';

/**
 * Per-sender next-nonce lookup. Thin proxy onto the Poster's
 * `/nonce/<sender>` endpoint. The Poster's monotonicity check is
 * per-sender across every contentTag it serves, so this works
 * unchanged for the forum tag.
 *
 * On any upstream miss (unreachable, 500, malformed body) we return
 * 502 with `nonce_lookup_failed`. The signing-flow's stale-nonce
 * retry loop expects an authoritative answer; an underestimated
 * `nextNonce` would exhaust retries and fail the submit at the wall.
 */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const sender = request.nextUrl.searchParams.get('sender');
  if (sender === null || !ADDRESS_RE.test(sender)) {
    return NextResponse.json({ error: 'invalid_sender' }, { status: 400 });
  }

  try {
    const poster = await getNextNonce({ sender: sender.toLowerCase() });
    if (poster.status !== 200) {
      return NextResponse.json(
        {
          error: 'nonce_lookup_failed',
          detail: 'poster /nonce non-200',
          upstreamStatus: poster.status,
        },
        { status: 502 }
      );
    }
    const body = poster.body as { nextNonce?: unknown };
    if (typeof body.nextNonce !== 'string') {
      return NextResponse.json(
        { error: 'nonce_lookup_failed', detail: 'poster /nonce missing nextNonce' },
        { status: 502 }
      );
    }
    return NextResponse.json({ nextNonce: body.nextNonce });
  } catch (err) {
    const mapped = posterErrorToResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
