import { NextResponse } from 'next/server';

import type { Address, Bytes32 } from 'bam-sdk/browser';

import { badgeForConfirmed, resolveBadges } from '@/lib/badges';
import { COPROCESSOR_WINDOW, FORUM_TAG, READER_WINDOW } from '@/lib/constants';
import {
  coprocessorErrorToResponse,
  getProofs,
  getValidations,
} from '@/lib/coprocessor-client';
import { resolveEnsBatch } from '@/lib/ens';
import { decodeForumContentsHex, decodeTagBytes } from '@/lib/forum-decode';
import type { ForumMessage, ProofCounts } from '@/lib/forum-row';
import {
  listConfirmedMessages,
  readerErrorToResponse,
} from '@/lib/reader-client';

/**
 * GET `/api/confirmed` — confirmed messages for the forum tag, with
 * 4-state badges resolved server-side and ENS names baked in. Returns
 * `{ messages, proofCounts }` shared by the `/` thread list and the
 * `/thread/[id]` view (same react-query key on the client).
 *
 * Parallel fetches reader + coprocessor; the coprocessor's
 * `/validation/latest` is treated as empty when the service hasn't
 * validated anything yet (503 with no cursor — handled in client).
 */

interface ReaderMessageRow {
  sender: string;
  nonce: string;
  contentTag: string;
  contents: string;
  signature: string;
  messageHash: string;
  batchRef: string | null;
  blockNumber: number | null;
  txIndex: number | null;
  messageIndexWithinBatch: number | null;
}

export async function GET(): Promise<NextResponse> {
  try {
    const [readerResp, validations, proofs] = await Promise.all([
      listConfirmedMessages({
        contentTag: FORUM_TAG,
        status: 'confirmed',
        limit: READER_WINDOW,
      }),
      getValidations({ limit: COPROCESSOR_WINDOW }),
      getProofs({ limit: COPROCESSOR_WINDOW }),
    ]);

    if (readerResp.status !== 200 || !readerResp.body || typeof readerResp.body !== 'object') {
      return NextResponse.json(
        { error: 'reader_lookup_failed', upstreamStatus: readerResp.status },
        { status: 502 }
      );
    }
    const rows = (readerResp.body as { messages?: ReaderMessageRow[] }).messages ?? [];

    const badgeIndex = resolveBadges({
      validations: validations.items,
      proofs: proofs.items,
    });

    // Collect distinct senders, batch-resolve ENS.
    const distinctSenders = Array.from(
      new Set(rows.map((r) => r.sender.toLowerCase()))
    );
    const ensMap = await resolveEnsBatch(distinctSenders);

    const messages: ForumMessage[] = [];
    for (const row of rows) {
      const decoded = decodeForumContentsHex(row.contents);
      if (decoded === null) continue;
      const resolved = badgeForConfirmed(badgeIndex, row.messageHash);
      const baseShared = {
        messageHash: row.messageHash as Bytes32,
        sender: row.sender as Address,
        senderEns: ensMap[row.sender.toLowerCase()] ?? null,
        nonce: row.nonce,
        status: resolved.status,
        txHash: row.batchRef,
        blockNumber: row.blockNumber,
        timestamp: Number(decoded.timestamp),
        ...(resolved.proofCommitment !== undefined
          ? { proofCommitment: resolved.proofCommitment }
          : {}),
      };
      switch (decoded.kind) {
        case 0x00:
          messages.push({
            ...baseShared,
            kind: 'post',
            title: decoded.title,
            tag: decodeTagBytes(decoded.tag),
            body: decoded.body,
          });
          break;
        case 0x01:
          messages.push({
            ...baseShared,
            kind: 'reply',
            parentMessageHash: decoded.parentMessageHash as Bytes32,
            body: decoded.body,
          });
          break;
        case 0x02:
          messages.push({
            ...baseShared,
            kind: 'like',
            targetMessageHash: decoded.targetMessageHash as Bytes32,
          });
          break;
      }
    }

    const proofCounts: ProofCounts = {
      validated: badgeIndex.validatedCount,
      proven: badgeIndex.provenCount,
      latestProvenAt: badgeIndex.latestProvenAt,
    };

    return NextResponse.json({ messages, proofCounts });
  } catch (err) {
    const readerMapped = readerErrorToResponse(err);
    if (readerMapped) return readerMapped;
    const coprocMapped = coprocessorErrorToResponse(err);
    if (coprocMapped) return coprocMapped;
    throw err;
  }
}
