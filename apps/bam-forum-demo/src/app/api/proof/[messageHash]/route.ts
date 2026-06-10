import { NextRequest, NextResponse } from 'next/server';

import {
  coprocessorErrorToResponse,
  getProofByMessageHash,
} from '@/lib/coprocessor-client';

/**
 * GET `/api/proof/[messageHash]` — proxies the coprocessor's per-message
 * proof bundle (proof bytes + public values + vk url + metadata).
 * Returns 404 when the coprocessor has no proof for that message yet.
 * The drawer fetches this lazily on click, never on initial page load.
 */

const HASH_RE = /^0x[0-9a-f]{64}$/;

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ messageHash: string }> }
): Promise<NextResponse> {
  const { messageHash } = await context.params;
  const lower = messageHash.toLowerCase();
  if (!HASH_RE.test(lower)) {
    return NextResponse.json({ error: 'invalid_message_hash' }, { status: 400 });
  }

  try {
    const bundle = await getProofByMessageHash(lower);
    if (bundle === null) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json(bundle);
  } catch (err) {
    const mapped = coprocessorErrorToResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
