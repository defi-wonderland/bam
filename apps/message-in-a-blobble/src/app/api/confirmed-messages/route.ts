import { NextResponse } from 'next/server';

import { getMessages } from '@/db/queries';

/**
 * Read surface for **confirmed** messages — the ones the sync indexer
 * has decoded from on-chain blob batches and written to the demo's own
 * `messages` table. Pending messages (not yet on chain) come from the
 * Poster via `/api/messages`; this route is the other half of the
 * split (see plan.md's §Architecture note: post-migration, the demo's
 * DB is confirmed-history only).
 */
export async function GET(): Promise<NextResponse> {
  try {
    const messages = await getMessages('posted');
    return NextResponse.json({ messages });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
