import { NextRequest, NextResponse } from 'next/server';

import type { Address, Bytes32 } from 'bam-sdk/browser';

import { FORUM_TAG } from '@/lib/constants';
import { decodeForumContentsHex, decodeTagBytes } from '@/lib/forum-decode';
import type { ForumMessage } from '@/lib/forum-row';
import { getPending, posterErrorToResponse } from '@/lib/poster-client';
import { resolveEnsBatch } from '@/lib/ens';

/**
 * GET `/api/pending?sender=0x…` — the connected wallet's own pending
 * messages, decoded into `ForumMessage[]` with `status: 'pending'`.
 *
 * Scope is intentionally per-sender: per the Notion spec, unconfirmed
 * messages from other users are not surfaced until they land on-chain.
 * Without a `sender` we return an empty list (the client passes `null`
 * when no wallet is connected; we don't gate the fetch on the
 * client).
 */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

interface PendingRow {
  sender: string;
  nonce: string;
  contentTag: string;
  contents: string;
  signature: string;
  messageHash: string;
  ingestedAt?: number;
  ingestSeq?: number;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const senderRaw = request.nextUrl.searchParams.get('sender');
  if (senderRaw === null || senderRaw.length === 0) {
    return NextResponse.json({ messages: [] });
  }
  if (!ADDRESS_RE.test(senderRaw)) {
    return NextResponse.json({ error: 'invalid_sender' }, { status: 400 });
  }
  const sender = senderRaw.toLowerCase();

  try {
    const poster = await getPending({ contentTag: FORUM_TAG, limit: 1000 });
    if (poster.status !== 200 || !poster.body || typeof poster.body !== 'object') {
      return NextResponse.json(
        { error: 'pending_lookup_failed', upstreamStatus: poster.status },
        { status: 502 }
      );
    }
    const rows = ((poster.body as { pending?: PendingRow[] }).pending ?? []).filter(
      (r) => r.sender.toLowerCase() === sender
    );

    const ensMap = await resolveEnsBatch([sender]);
    const senderEns = ensMap[sender] ?? null;

    const messages: ForumMessage[] = [];
    for (const row of rows) {
      const decoded = decodeForumContentsHex(row.contents);
      if (decoded === null) continue;

      messages.push(toForumMessage(row, decoded, senderEns));
    }
    return NextResponse.json({ messages });
  } catch (err) {
    const mapped = posterErrorToResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}

function toForumMessage(
  row: PendingRow,
  decoded: ReturnType<typeof decodeForumContentsHex>,
  senderEns: string | null
): ForumMessage {
  if (decoded === null) {
    throw new Error('toForumMessage called with null payload');
  }
  const baseShared = {
    messageHash: row.messageHash as Bytes32,
    sender: row.sender as Address,
    senderEns,
    nonce: row.nonce,
    status: 'pending' as const,
    txHash: null,
    blockNumber: null,
    timestamp: Number(decoded.timestamp),
  };
  switch (decoded.kind) {
    case 0x00:
      return {
        ...baseShared,
        kind: 'post',
        title: decoded.title,
        tag: decodeTagBytes(decoded.tag),
        body: decoded.body,
      };
    case 0x01:
      return {
        ...baseShared,
        kind: 'reply',
        parentMessageHash: decoded.parentMessageHash as Bytes32,
        body: decoded.body,
      };
    case 0x02:
      return {
        ...baseShared,
        kind: 'like',
        targetMessageHash: decoded.targetMessageHash as Bytes32,
      };
  }
}
