/**
 * Concurrent-writer convergence under composite key (T025, C-5).
 *
 * Setup: a packed transaction emits N `BlobBatchRegistered` events
 * sharing one `txHash`. Two writers race against the same store:
 *   - Poster: writes all N rows in ONE `withTxn` (the AggregatorLoop
 *     post-success path).
 *   - Reader: writes the same N rows event-by-event in N separate
 *     `withTxn`s, interleaved with the Poster.
 *
 * Both writer orderings (Poster-first, Reader-first, interleaved)
 * MUST converge to the same end state: per-tag rows present once
 * each, snapshots preserved (first-writer wins), `submittedAt` and
 * `submitter`+`l1IncludedAtUnixSec` COALESCEd across writers.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Address, Bytes32 } from 'bam-sdk';
import { createMemoryStore, type BamStore, type BatchMessageSnapshotEntry } from 'bam-store';

const CHAIN_ID = 11155111;
const PACKED_TX = ('0x' + 'cc'.repeat(32)) as Bytes32;
const PACKED_BLOCK = 100;
const VERSIONED_HASH = ('0x01' + '00'.repeat(31)) as Bytes32;
const SUBMITTER = ('0x' + 'ab'.repeat(20)) as Address;
const TAGS: Bytes32[] = [
  ('0x' + 'a1'.repeat(32)) as Bytes32,
  ('0x' + 'a2'.repeat(32)) as Bytes32,
  ('0x' + 'a3'.repeat(32)) as Bytes32,
];

const stores: BamStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

async function newStore(): Promise<BamStore> {
  const s = await createMemoryStore();
  stores.push(s);
  return s;
}

interface WriterRow {
  contentTag: Bytes32;
  /** Poster snapshot: non-empty (one entry per included message). */
  posterSnapshot: BatchMessageSnapshotEntry[];
}

const POSTER_ROWS: WriterRow[] = TAGS.map((tag, i) => ({
  contentTag: tag,
  posterSnapshot: [
    {
      author: ('0x' + (i + 1).toString(16).padStart(40, '0')) as Address,
      nonce: BigInt(i + 1),
      messageId: ('0x' + 'mm'.repeat(32).slice(0, 64)) as Bytes32,
      messageHash: ('0x' + 'hh'.repeat(32).slice(0, 64)) as Bytes32,
      messageIndexWithinBatch: 0,
    },
  ],
}));

async function writePoster(store: BamStore, submittedAt: number): Promise<void> {
  // Poster writes all N rows in ONE withTxn — mirrors AggregatorLoop's
  // post-success path. Snapshot non-empty; submittedAt + submitter
  // populated; l1IncludedAtUnixSec null.
  await store.withTxn(async (txn) => {
    for (const row of POSTER_ROWS) {
      await txn.upsertBatch({
        txHash: PACKED_TX,
        chainId: CHAIN_ID,
        contentTag: row.contentTag,
        blobVersionedHash: VERSIONED_HASH,
        batchContentHash: VERSIONED_HASH,
        blockNumber: PACKED_BLOCK,
        txIndex: 0,
        status: 'confirmed',
        replacedByTxHash: null,
        submittedAt,
        invalidatedAt: null,
        submitter: SUBMITTER,
        l1IncludedAtUnixSec: null,
        messageSnapshot: row.posterSnapshot,
      });
    }
  });
}

async function writeReaderEvent(
  store: BamStore,
  contentTag: Bytes32,
  l1IncludedAtUnixSec: number
): Promise<void> {
  // Reader writes one row per event in its own withTxn — empty
  // snapshot (it observed the event but hasn't decoded the per-msg
  // bytes yet); submittedAt null; submitter populated; l1 inclusion
  // time populated.
  await store.withTxn(async (txn) => {
    await txn.upsertBatch({
      txHash: PACKED_TX,
      chainId: CHAIN_ID,
      contentTag,
      blobVersionedHash: VERSIONED_HASH,
      batchContentHash: VERSIONED_HASH,
      blockNumber: PACKED_BLOCK,
      txIndex: 0,
      status: 'confirmed',
      replacedByTxHash: null,
      submittedAt: null,
      invalidatedAt: null,
      submitter: SUBMITTER,
      l1IncludedAtUnixSec,
      messageSnapshot: [],
    });
  });
}

async function readBatches(store: BamStore): Promise<
  { contentTag: Bytes32; submittedAt: number | null; l1: number | null; snapshotCount: number }[]
> {
  return store.withTxn(async (txn) => {
    const rows = await txn.getBatchesByTxHash(CHAIN_ID, PACKED_TX);
    return rows.map((r) => ({
      contentTag: r.contentTag,
      submittedAt: r.submittedAt,
      l1: r.l1IncludedAtUnixSec,
      snapshotCount: r.messageSnapshot.length,
    }));
  });
}

describe('concurrent-writer convergence under composite key (T025)', () => {
  it('Poster-first then Reader produces N rows with COALESCEd fields', async () => {
    const store = await newStore();
    await writePoster(store, 1_234);
    for (const tag of TAGS) {
      await writeReaderEvent(store, tag, 1_700_000_000);
    }
    const rows = await readBatches(store);
    expect(rows).toHaveLength(TAGS.length);
    for (const r of rows) {
      // First-writer's submittedAt preserved (Poster set it).
      expect(r.submittedAt).toBe(1_234);
      // Second-writer's l1IncludedAtUnixSec landed (Poster left null).
      expect(r.l1).toBe(1_700_000_000);
      // Poster's non-empty snapshot preserved across the empty-snapshot writer.
      expect(r.snapshotCount).toBe(1);
    }
  });

  it('Reader-first then Poster also produces N rows with COALESCEd fields', async () => {
    const store = await newStore();
    for (const tag of TAGS) {
      await writeReaderEvent(store, tag, 1_700_000_000);
    }
    await writePoster(store, 1_234);
    const rows = await readBatches(store);
    expect(rows).toHaveLength(TAGS.length);
    for (const r of rows) {
      expect(r.submittedAt).toBe(1_234);
      expect(r.l1).toBe(1_700_000_000);
      expect(r.snapshotCount).toBe(1);
    }
  });

  it('interleaved Reader/Poster writes converge to the same end state', async () => {
    const store = await newStore();
    // Reader writes [0], Poster writes all, Reader writes [1] and [2].
    await writeReaderEvent(store, TAGS[0]!, 1_700_000_000);
    await writePoster(store, 1_234);
    await writeReaderEvent(store, TAGS[1]!, 1_700_000_000);
    await writeReaderEvent(store, TAGS[2]!, 1_700_000_000);
    const rows = await readBatches(store);
    expect(rows).toHaveLength(TAGS.length);
    for (const r of rows) {
      expect(r.submittedAt).toBe(1_234);
      expect(r.l1).toBe(1_700_000_000);
      expect(r.snapshotCount).toBe(1);
    }
  });
});
