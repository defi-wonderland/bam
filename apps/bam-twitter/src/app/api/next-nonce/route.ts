import { NextRequest, NextResponse } from 'next/server';

import { KNOWN_CONTENT_TAGS } from '@/lib/constants';
import { getPending, posterErrorToResponse } from '@/lib/poster-client';
import {
  listConfirmedMessages,
  readerErrorToResponse,
} from '@/lib/reader-client';

/**
 * Returns `max(nonce) + 1` for `sender` across every contentTag this
 * Poster + Reader handle. Walks the Poster's `/pending` (no tag
 * filter — it returns all pending across tags) and the Reader's
 * `/messages?status=confirmed` once per known tag (the Reader
 * requires a contentTag).
 *
 * Necessary because the Poster's monotonicity check is per sender
 * across all tags (`packages/bam-poster/src/ingest/monotonicity.ts:11`):
 * a per-tag estimate would live-lock when the same wallet posts in
 * multiple apps on the same Poster.
 *
 * Failure mode: if any upstream call fails (Poster or any tag's
 * Reader read), this route returns 502 rather than a partial answer.
 * An underestimated `nextNonce` would round-trip through Composer's
 * `stale_nonce` retry loop and exhaust on a stuck max — failing fast
 * surfaces the upstream problem instead of hiding it.
 *
 * TODO(perf): the unbounded scan grows with shared Poster/Reader
 * history. Long-term replacement is either a Poster `/nonce/:sender`
 * endpoint (cheapest) or an `author` filter on the Reader's
 * `/messages` HTTP surface. Tracked in the README.
 */

interface PosterPendingRow {
  sender: string;
  nonce: string | number;
}

interface ReaderMessageRow {
  author: string;
  nonce: string;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function parseNonce(v: string | number): bigint | null {
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const sender = request.nextUrl.searchParams.get('sender');
  if (sender === null || !ADDRESS_RE.test(sender)) {
    return NextResponse.json({ error: 'invalid_sender' }, { status: 400 });
  }
  const lc = sender.toLowerCase();

  let max = -1n;

  // Pending across all tags — single Poster call.
  try {
    const poster = await getPending({});
    if (poster.status !== 200) {
      return NextResponse.json(
        { error: 'nonce_lookup_failed', detail: 'poster /pending non-200', upstreamStatus: poster.status },
        { status: 502 }
      );
    }
    const pending = (poster.body as { pending?: PosterPendingRow[] }).pending ?? [];
    for (const p of pending) {
      if (p.sender.toLowerCase() !== lc) continue;
      const n = parseNonce(p.nonce);
      if (n !== null && n > max) max = n;
    }
  } catch (err) {
    const mapped = posterErrorToResponse(err);
    if (mapped) return mapped;
    throw err;
  }

  // Confirmed view: Reader requires a contentTag, so fan out per known tag.
  // Any tag failing fails the whole request — see header note on
  // why we don't return a partial answer.
  for (const tag of KNOWN_CONTENT_TAGS) {
    try {
      const reader = await listConfirmedMessages({ contentTag: tag, status: 'confirmed' });
      if (reader.status !== 200) {
        return NextResponse.json(
          {
            error: 'nonce_lookup_failed',
            detail: `reader /messages non-200 for tag ${tag}`,
            upstreamStatus: reader.status,
          },
          { status: 502 }
        );
      }
      const rows = (reader.body as { messages?: ReaderMessageRow[] }).messages ?? [];
      for (const r of rows) {
        if (r.author.toLowerCase() !== lc) continue;
        const n = parseNonce(r.nonce);
        if (n !== null && n > max) max = n;
      }
    } catch (err) {
      const mapped = readerErrorToResponse(err);
      if (mapped) return mapped;
      throw err;
    }
  }

  return NextResponse.json({ nextNonce: (max + 1n).toString() });
}
