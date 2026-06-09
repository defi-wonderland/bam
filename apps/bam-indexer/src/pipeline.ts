/**
 * Twitter indexing pipeline.
 *
 * Replicates what bam-reader does (fetch → extract → decode → dedup)
 * and what bam-twitter's timeline.ts does (decode twitter contents),
 * but in a single self-contained pass suitable for ZK proving later.
 *
 * Ordering: canonical chain order (blockNumber, txIndex, messageIndexWithinBatch).
 * This is intentionally different from the bam-twitter frontend, which sorts
 * by app-layer timestamp. The ZK proof uses chain order.
 */

import { createHash } from 'node:crypto';
import { hexToBytes, extractSegmentBytes, decodeBatch } from 'bam-sdk';
import { TWITTER_TAG } from './constants.js';
import type { BlobBatch } from './chain-fetcher.js';
import { decodeTwitterContents } from './twitter-codec.js';
import type { TwitterMessage } from './twitter-codec.js';

// ── Reader wire types ─────────────────────────────────────────────────────────

interface ReaderMessageRow {
  messageId: string | null;
  author: string;
  nonce: string;             // bigint serialized as decimal string by Reader
  contentTag: string;
  contents: string;          // 0x-prefixed hex
  signature: string;
  messageHash: string;
  status: string;
  batchRef: string | null;   // tx hash of the batch
  blockNumber: number | null;
  txIndex: number | null;
  messageIndexWithinBatch: number | null;
}

// ── Pipeline output types ─────────────────────────────────────────────────────

export interface ChainCoord {
  blockNumber: number;
  txIndex: number;
  messageIndexWithinBatch: number;
}

export interface IndexedTweet {
  author: string;
  nonce: bigint;
  messageHash: string;
  app: TwitterMessage;
  coord: ChainCoord;
  txHash: string;
}

// ── Step 1: fetch ─────────────────────────────────────────────────────────────

export async function fetchConfirmedMessages(readerUrl: string): Promise<ReaderMessageRow[]> {
  const url = `${readerUrl.replace(/\/$/, '')}/messages?contentTag=${TWITTER_TAG}&status=confirmed&limit=1000`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Reader responded ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { messages?: ReaderMessageRow[] };
  return data.messages ?? [];
}

// ── Step 2: decode + sort + dedup ─────────────────────────────────────────────

export interface BuildTimelineResult {
  timeline: IndexedTweet[];
  skippedDecode: number;
  skippedDedup: number;
}

export function buildTimeline(rows: ReaderMessageRow[]): BuildTimelineResult {
  let skippedDecode = 0;
  let skippedDedup = 0;

  // Decode each row. Drop rows with missing chain coords or bad contents.
  const decoded: IndexedTweet[] = [];
  for (const row of rows) {
    if (row.blockNumber === null || row.txIndex === null || row.messageIndexWithinBatch === null) {
      skippedDecode++;
      continue;
    }
    try {
      const { app } = decodeTwitterContents(hexToBytes(row.contents));
      decoded.push({
        author: row.author,
        nonce: BigInt(row.nonce),
        messageHash: row.messageHash,
        app,
        coord: {
          blockNumber: row.blockNumber,
          txIndex: row.txIndex,
          messageIndexWithinBatch: row.messageIndexWithinBatch,
        },
        txHash: row.batchRef ?? '',
      });
    } catch {
      skippedDecode++;
    }
  }

  // Sort by canonical chain order.
  decoded.sort((a, b) => {
    if (a.coord.blockNumber !== b.coord.blockNumber) return a.coord.blockNumber - b.coord.blockNumber;
    if (a.coord.txIndex !== b.coord.txIndex) return a.coord.txIndex - b.coord.txIndex;
    return a.coord.messageIndexWithinBatch - b.coord.messageIndexWithinBatch;
  });

  // Dedup: first (author, nonce) wins — same rule as bam-store's upsertObserved.
  const seen = new Set<string>();
  const timeline: IndexedTweet[] = [];
  for (const tweet of decoded) {
    const key = `${tweet.author.toLowerCase()}:${tweet.nonce}`;
    if (seen.has(key)) {
      skippedDedup++;
      continue;
    }
    seen.add(key);
    timeline.push(tweet);
  }

  return { timeline, skippedDecode, skippedDedup };
}

// ── Step 3: compute timeline root ─────────────────────────────────────────────

/**
 * R = sha256 of length-prefixed tweet records in chain order.
 *
 * Per-tweet record: sender(20) || nonce_be8(8) || timestamp_be8(8) || content(utf-8)
 * Framing: uint32_be(record.length) || record, for each tweet, concatenated.
 *
 * This format is pinned here so Phase 2 (Rust) uses the identical layout.
 */
export function computeTimelineRoot(timeline: IndexedTweet[]): string {
  const encoder = new TextEncoder();
  const hash = createHash('sha256');

  for (const tweet of timeline) {
    const contentBytes = encoder.encode(tweet.app.content);
    const timestamp = tweet.app.timestamp;

    // record = sender(20) || nonce_be8(8) || timestamp_be8(8) || content
    const record = new Uint8Array(20 + 8 + 8 + contentBytes.length);
    const dv = new DataView(record.buffer);

    // sender (20 bytes)
    const senderHex = tweet.author.startsWith('0x') ? tweet.author.slice(2) : tweet.author;
    for (let i = 0; i < 20; i++) {
      record[i] = parseInt(senderHex.slice(i * 2, i * 2 + 2), 16);
    }
    // nonce (8 bytes BE)
    dv.setBigUint64(20, tweet.nonce, false);
    // timestamp (8 bytes BE)
    dv.setBigUint64(28, BigInt(timestamp), false);
    // content
    record.set(contentBytes, 36);

    // length prefix (uint32 BE)
    const lenBuf = new Uint8Array(4);
    new DataView(lenBuf.buffer).setUint32(0, record.length, false);

    hash.update(lenBuf);
    hash.update(record);
  }

  return '0x' + hash.digest('hex');
}

// ── Chain-based pipeline (no Reader needed) ───────────────────────────────────

/**
 * Same pipeline as buildTimeline, but starting from raw blob bytes
 * fetched directly from chain instead of from the Reader's HTTP API.
 */
export function buildTimelineFromBlobs(batches: BlobBatch[]): BuildTimelineResult {
  let skippedDecode = 0;
  let skippedDedup = 0;

  // Sort batches into canonical chain order first.
  const sorted = [...batches].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
    return a.logIndex - b.logIndex;
  });

  const decoded: IndexedTweet[] = [];

  for (const batch of sorted) {
    let messages: ReturnType<typeof decodeBatch>['messages'];
    try {
      const usableBytes = extractSegmentBytes(batch.blobBytes, batch.startFE, batch.endFE);
      ({ messages } = decodeBatch(usableBytes));
    } catch {
      skippedDecode++;
      continue;
    }

    for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
      const msg = messages[msgIdx]!;
      try {
        const { app } = decodeTwitterContents(msg.contents);
        decoded.push({
          author: msg.sender,
          nonce: msg.nonce,
          messageHash: '',  // not available without running keccak, skip for now
          app,
          coord: {
            blockNumber: batch.blockNumber,
            txIndex: batch.txIndex,
            messageIndexWithinBatch: msgIdx,
          },
          txHash: batch.txHash,
        });
      } catch {
        skippedDecode++;
      }
    }
  }

  // Sort by canonical chain order.
  decoded.sort((a, b) => {
    if (a.coord.blockNumber !== b.coord.blockNumber) return a.coord.blockNumber - b.coord.blockNumber;
    if (a.coord.txIndex !== b.coord.txIndex) return a.coord.txIndex - b.coord.txIndex;
    return a.coord.messageIndexWithinBatch - b.coord.messageIndexWithinBatch;
  });

  // Dedup: first (author, nonce) wins.
  const seen = new Set<string>();
  const timeline: IndexedTweet[] = [];
  for (const tweet of decoded) {
    const key = `${tweet.author.toLowerCase()}:${tweet.nonce}`;
    if (seen.has(key)) { skippedDedup++; continue; }
    seen.add(key);
    timeline.push(tweet);
  }

  return { timeline, skippedDecode, skippedDedup };
}
