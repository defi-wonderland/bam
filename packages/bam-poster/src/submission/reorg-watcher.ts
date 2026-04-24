import type { Bytes32 } from 'bam-sdk';

import type { BamStore, BatchRow, MessageRow } from '../types.js';

/**
 * Abstraction over the L1 block-header source the watcher needs.
 * Implementations can be viem's `publicClient.getTransactionReceipt` +
 * `getBlock`, or a test stub.
 */
export interface BlockSource {
  /** Current finalized-ish head of the canonical chain. */
  getBlockNumber(): Promise<bigint>;
  /**
   * Returns `null` if the tx is no longer on the canonical chain at
   * all. Returns the current block number containing the tx if it is.
   */
  getTransactionBlock(txHash: Bytes32): Promise<number | null>;
}

export interface ReorgWatcherOptions {
  store: BamStore;
  blockSource: BlockSource;
  /** Window within which reorgs are re-enqueued. Clamped [4, 128]. */
  reorgWindowBlocks: number;
  now: () => Date;
}

export const MIN_REORG_WINDOW = 4;
export const MAX_REORG_WINDOW = 128;
export const DEFAULT_REORG_WINDOW = 32;

export function clampReorgWindow(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_REORG_WINDOW;
  return Math.min(Math.max(Math.floor(n), MIN_REORG_WINDOW), MAX_REORG_WINDOW);
}

/**
 * Reorg watcher.
 *
 * Each tick:
 *   - Walks confirmed batches within the reorg window of the
 *     current canonical head.
 *   - For each, asks `blockSource.getTransactionBlock(tx_hash)`.
 *   - If the tx is no longer on the canonical chain, call
 *     `markReorged(tx_hash, invalidatedAt)` — which cascades confirmed
 *     messages under the batch to `reorged` — and re-enqueue those
 *     messages to `pending` with fresh ingest seqs at the tail of the
 *     queue. The submission loop will pick them up again.
 *
 * Nonce monotonicity is NOT re-validated on re-enqueue: the
 * per-author `last_nonce` tracker is monotonic over time and doesn't
 * regress on reorg. Re-enqueue identity is `(sender, nonce,
 * contents)`; a fresh ingest with the same `(sender, nonce)` cannot
 * exist here because it would have been rejected as `stale_nonce` at
 * its own ingest time.
 *
 * Out-of-window entries are left alone.
 */
export class ReorgWatcher {
  constructor(private readonly opts: ReorgWatcherOptions) {}

  async tick(): Promise<{ reorgedCount: number; keptCount: number }> {
    const head = await this.opts.blockSource.getBlockNumber();
    const window = clampReorgWindow(this.opts.reorgWindowBlocks);
    const windowStart = head - BigInt(window);

    const candidates = await this.opts.store.withTxn(async (txn) => {
      const recent = await txn.listBatches({ sinceBlock: windowStart });
      return recent.filter((b) => b.status === 'confirmed' && b.blockNumber !== null);
    });

    let reorgedCount = 0;
    let keptCount = 0;

    for (const batch of candidates) {
      const current = await this.opts.blockSource.getTransactionBlock(batch.txHash);
      if (current !== null) {
        keptCount++;
        continue;
      }
      reorgedCount++;
      await this.reorgBatch(batch);
    }

    return { reorgedCount, keptCount };
  }

  private async reorgBatch(batch: BatchRow): Promise<void> {
    await this.opts.store.withTxn(async (txn) => {
      const invalidatedAt = this.opts.now().getTime();
      // Fetch the attached messages BEFORE markReorged so we have the
      // payloads in a stable order for re-enqueue.
      const attached = await txn.listMessages({ batchRef: batch.txHash });
      await txn.markReorged(batch.txHash, invalidatedAt);

      // Re-enqueue in original-ingest order, with NEW ingest_seq
      // values at the tail of the tag queue.
      const ordered = [...attached].sort(
        (a: MessageRow, b: MessageRow) => (a.ingestSeq ?? 0) - (b.ingestSeq ?? 0)
      );
      const ingestedAt = this.opts.now().getTime();
      for (const m of ordered) {
        const existing = await txn.getByAuthorNonce(m.author, m.nonce);
        if (existing !== null && existing.status === 'pending') continue;
        const seq = await txn.nextIngestSeq(batch.contentTag);
        await txn.upsertObserved({
          messageId: null,
          author: m.author,
          nonce: m.nonce,
          contentTag: batch.contentTag,
          contents: new Uint8Array(m.contents),
          signature: new Uint8Array(m.signature),
          messageHash: m.messageHash,
          status: 'pending',
          batchRef: null,
          ingestedAt,
          ingestSeq: seq,
          blockNumber: null,
          txIndex: null,
          messageIndexWithinBatch: null,
        });
      }
    });
  }
}
