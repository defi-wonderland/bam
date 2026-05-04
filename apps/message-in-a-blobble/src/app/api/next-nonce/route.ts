import { NextRequest, NextResponse } from 'next/server';

import { getNextNonce, posterErrorToResponse } from '@/lib/poster-client';

/**
 * Per-sender next-nonce lookup. Thin proxy onto the Poster's
 * `/nonce/<sender>` endpoint, which reads the per-sender nonce tracker
 * directly. Authoritative because the Poster's monotonicity check is
 * per-sender across every contentTag it serves
 * (`packages/bam-poster/src/ingest/monotonicity.ts`).
 *
 * On any upstream miss (Poster unreachable, 500, malformed body) we
 * return 502 with `nonce_lookup_failed` rather than a partial answer:
 * an underestimated `nextNonce` would round-trip through the Composer's
 * `stale_nonce` retry loop and exhaust on a stuck max — failing fast
 * surfaces the upstream problem instead of hiding it behind wallet
 * popups.
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
