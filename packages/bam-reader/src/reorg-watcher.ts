/**
 * Reader-side reorg watcher.
 *
 * Mirrors the shape of `packages/bam-poster/src/submission/reorg-watcher.ts`
 * with two deliberate differences:
 *  1. The candidate set is **all** `confirmed` `BatchRow`s for the
 *     configured `chainId`, not just self-submitted ones (the Reader
 *     observes everything, not only what the Poster wrote).
 *  2. Reader has no submission loop, so reorg detection does **not**
 *     re-enqueue messages to `pending`. The cascade triggered by
 *     `markReorged` (confirmed → reorged on every attached message)
 *     is the watcher's only effect.
 *
 * Window default of 32 blocks (~6 minutes on mainnet) matches the
 * Poster's. Deeper reorgs are documented as out-of-scope (operator
 * re-runs backfill).
 */

import type { Bytes32 } from 'bam-sdk';
import type { BamStore } from 'bam-store';

export interface BlockSource {
  /** Current finalized-ish head of the canonical chain. */
  getBlockNumber(): Promise<bigint>;
  /**
   * Returns `null` if the tx is no longer on the canonical chain at
   * all. Returns the current block number containing the tx if it is.
   */
  getTransactionBlock(txHash: Bytes32): Promise<number | null>;
}

export interface ReaderReorgWatcherOptions {
  store: BamStore;
  blockSource: BlockSource;
  /**
   * Chain id this Reader is configured for. Filters batch candidates
   * so a shared DB containing batches from multiple chains never
   * causes the wrong chain's batches to be reorged.
   */
  chainId: number;
  /** Reorg window. Clamped to [MIN_REORG_WINDOW, MAX_REORG_WINDOW]. */
  reorgWindowBlocks: number;
  now?: () => Date;
}

export const MIN_REORG_WINDOW = 4;
export const MAX_REORG_WINDOW = 128;
export const DEFAULT_REORG_WINDOW = 32;

export function clampReorgWindow(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_REORG_WINDOW;
  return Math.min(Math.max(Math.floor(n), MIN_REORG_WINDOW), MAX_REORG_WINDOW);
}

export class ReaderReorgWatcher {
  constructor(private readonly opts: ReaderReorgWatcherOptions) {}

  async tick(): Promise<{ reorgedCount: number; keptCount: number }> {
    const head = await this.opts.blockSource.getBlockNumber();
    const window = clampReorgWindow(this.opts.reorgWindowBlocks);
    const windowStart = head - BigInt(window);
    const now = this.opts.now ?? (() => new Date());

    const candidates = await this.opts.store.withTxn(async (txn) => {
      const recent = await txn.listBatches({
        chainId: this.opts.chainId,
        sinceBlock: windowStart,
      });
      return recent.filter(
        (b) => b.status === 'confirmed' && b.blockNumber !== null
      );
    });

    let reorgedCount = 0;
    let keptCount = 0;

    for (const batch of candidates) {
      const current = await this.opts.blockSource.getTransactionBlock(batch.txHash);
      if (current !== null) {
        keptCount += 1;
        continue;
      }
      reorgedCount += 1;
      await this.opts.store.withTxn(async (txn) => {
        await txn.markReorged(batch.txHash, now().getTime());
      });
    }

    return { reorgedCount, keptCount };
  }
}
