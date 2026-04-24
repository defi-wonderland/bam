import type { Bytes32 } from 'bam-sdk';

import type {
  MessageSnapshot,
  PosterStore,
  StoreTxnSubmittedRow,
} from '../types.js';

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
  store: PosterStore;
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
 *   - Walks entries in `poster_submitted_batches` with status
 *     `included` whose `blockNumber` is within the reorg window of the
 *     current canonical head.
 *   - For each, asks `blockSource.getTransactionBlock(tx_hash)`.
 *   - If the tx is no longer on the canonical chain, mark the entry
 *     `reorged`, re-enqueue its messages into the pending pool in
 *     their original ingest order (bypassing monotonicity — they
 *     passed it on initial ingest and `poster_nonces.last_nonce` must
 *     not regress), and let the submission loop pick them up again.
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
      const recent = await txn.listSubmitted({ sinceBlock: windowStart });
      return recent.filter((r) => r.status === 'included' && r.blockNumber !== null);
    });

    let reorgedCount = 0;
    let keptCount = 0;

    for (const entry of candidates) {
      const current = await this.opts.blockSource.getTransactionBlock(entry.txHash);
      if (current !== null) {
        keptCount++;
        continue;
      }
      reorgedCount++;
      await this.reorgEntry(entry);
    }

    return { reorgedCount, keptCount };
  }

  private async reorgEntry(entry: StoreTxnSubmittedRow): Promise<void> {
    await this.opts.store.withTxn(async (txn) => {
      // Mark as reorged and record the invalidation timestamp so clients
      // reading `listSubmittedBatches` see a distinct state transition.
      // The per-message `messageId` values stay in the snapshot for
      // operator forensics, but downstream surfaces return them as
      // `null` when status === 'reorged' — a new batch will produce a
      // fresh `batchContentHash` and therefore a fresh id.
      const invalidatedAt = this.opts.now().getTime();
      await txn.updateSubmittedStatus(entry.txHash, 'reorged', null, null, invalidatedAt);

      // Re-enqueue the messages in their original ingest order, with
      // NEW ingest_seq values at the tail of the tag queue (the
      // original seq belonged to a now-deleted pending row). Walk the
      // snapshots sorted by `originalIngestSeq` so the replay order
      // matches the original ingestion order.
      //
      // Nonce-monotonicity is NOT re-run: the last_nonce tracker is
      // monotonic over time and doesn't regress on reorg. Re-enqueue
      // identity is `(sender, nonce, contents)`; a fresh ingest with
      // the same `(sender, nonce)` cannot exist here because it would
      // have been rejected as `stale_nonce` at its own ingest time.
      const ordered = [...entry.messages].sort(
        (a: MessageSnapshot, b: MessageSnapshot) => a.originalIngestSeq - b.originalIngestSeq
      );
      const ingestedAt = this.opts.now().getTime();
      for (const snap of ordered) {
        const existing = await txn.getPendingByKey({ sender: snap.sender, nonce: snap.nonce });
        if (existing !== null) continue;
        const seq = await txn.nextIngestSeq(entry.contentTag);
        await txn.insertPending({
          contentTag: entry.contentTag,
          sender: snap.sender,
          nonce: snap.nonce,
          contents: new Uint8Array(snap.contents),
          signature: new Uint8Array(snap.signature),
          messageHash: snap.messageHash,
          ingestedAt,
          ingestSeq: seq,
        });
      }
    });
  }
}
