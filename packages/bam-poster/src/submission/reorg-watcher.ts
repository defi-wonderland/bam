import type { Bytes32 } from 'bam-sdk';

import type {
  PosterStore,
  StoreTxnSubmittedRow,
} from '../types.js';

// Hoisted so replaying reorged snapshots back into pending doesn't
// allocate a fresh TextEncoder per message.
const TEXT_ENCODER = new TextEncoder();

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
 * Reorg watcher (plan §C-12).
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
      // Mark as reorged — future resubmits link back via replaced_by_tx_hash.
      await txn.updateSubmittedStatus(entry.txHash, 'reorged', null, null);

      // Re-enqueue the messages in their original ingest order, with
      // NEW ingest_seq values at the tail of the tag queue (the
      // original seq belonged to a now-deleted pending row). Walk the
      // snapshots sorted by `originalIngestSeq` so the replay order
      // matches the original ingestion order.
      //
      // Nonce-monotonicity is NOT re-run: the last_nonce tracker is
      // monotonic over time and doesn't regress on reorg.
      //
      // Byte-equality with a hypothetical fresh ingest is structurally
      // impossible here: any fresh ingest with `nonce ≤ last_nonce`
      // would already have been rejected at its own ingest time.
      const ordered = [...entry.messages].sort(
        (a, b) => a.originalIngestSeq - b.originalIngestSeq
      );
      const ingestedAt = this.opts.now().getTime();
      for (const snap of ordered) {
        const existing = await txn.getPendingByMessageId(snap.messageId);
        if (existing !== null) continue; // fresh (no-op retry) already re-enqueued it
        const seq = await txn.nextIngestSeq(entry.contentTag);
        await txn.insertPending({
          messageId: snap.messageId,
          contentTag: entry.contentTag,
          author: snap.author,
          nonce: snap.nonce,
          timestamp: snap.timestamp,
          content: TEXT_ENCODER.encode(snap.content),
          signature: new Uint8Array(snap.signature),
          ingestedAt,
          ingestSeq: seq,
        });
      }
    });
  }
}
