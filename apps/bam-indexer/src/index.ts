#!/usr/bin/env tsx
/**
 * bam-indexer: produce the bam-twitter timeline from either:
 *   - RPC_URL → fetch events + blobs directly from chain (no Reader needed)
 *   - READER_URL → fetch decoded messages from a running Reader
 *
 * Usage:
 *   RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY pnpm start
 */

import { fetchBlobBatches, hasCachedBatches } from './chain-fetcher.js';
import {
  fetchConfirmedMessages,
  buildTimeline,
  buildTimelineFromBlobs,
  computeTimelineRoot,
} from './pipeline.js';
import type { IndexedTweet } from './pipeline.js';

const RPC_URL = process.env['RPC_URL'];
const READER_URL = process.env['READER_URL'] ?? 'http://localhost:8788';

function formatDate(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString();
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function printTimeline(timeline: IndexedTweet[]): void {
  console.log('─── Timeline (chain order) ───────────────────────────────────');
  if (timeline.length === 0) {
    console.log('  (empty)');
  }
  for (let i = 0; i < timeline.length; i++) {
    const t = timeline[i]!;
    const { blockNumber, txIndex, messageIndexWithinBatch } = t.coord;
    const isReply = t.app.kind === 'reply';
    const indent = isReply ? '  ↳' : '  ';
    const label = `#${String(i + 1).padStart(3, ' ')}`;
    const coord = `[block ${blockNumber} / tx ${txIndex} / msg ${messageIndexWithinBatch}]`;
    console.log(`${label} ${coord}  ${shortAddr(t.author)}  ${formatDate(t.app.timestamp)}`);
    console.log(`${indent}  ${t.app.content}`);
    if (isReply && t.app.kind === 'reply') {
      console.log(`       parent: ${t.app.parentMessageHash}`);
    }
  }
  console.log('──────────────────────────────────────────────────────────────\n');
}

async function main(): Promise<void> {
  let timeline: IndexedTweet[];
  let skippedDecode: number;
  let skippedDedup: number;

  if (RPC_URL || hasCachedBatches()) {
    // ── Chain path: RPC + Blobscan (or local cache) ───────────────────────
    const mode = hasCachedBatches() && !RPC_URL ? 'cache' : 'chain (RPC + Blobscan)';
    console.log(`Mode: ${mode}\n`);
    const batches = await fetchBlobBatches(RPC_URL, undefined, (msg) => console.log(msg));
    console.log(`  Fetched ${batches.length} blobs with data\n`);
    ({ timeline, skippedDecode, skippedDedup } = buildTimelineFromBlobs(batches));
  } else {
    // ── Reader path: HTTP API ─────────────────────────────────────────────
    console.log(`Mode: reader  ${READER_URL}\n`);
    const rows = await fetchConfirmedMessages(READER_URL);
    console.log(`Fetched ${rows.length} confirmed rows\n`);
    ({ timeline, skippedDecode, skippedDedup } = buildTimeline(rows));
  }

  console.log(`Decoded:  ${timeline.length + skippedDedup} messages`);
  if (skippedDecode > 0) console.log(`  skipped (bad format): ${skippedDecode}`);
  if (skippedDedup > 0) console.log(`  dropped  (dedup):     ${skippedDedup}`);
  console.log(`Timeline: ${timeline.length} tweets\n`);

  printTimeline(timeline);

  const R = computeTimelineRoot(timeline);
  console.log(`Timeline root R: ${R}`);
  console.log(`\nPublic inputs for the ZK proof:`);
  console.log(`  R = ${R}`);
  console.log(`  (C₁…Cₙ = versioned hashes from BlobBatchRegistered events on L1)`);
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
