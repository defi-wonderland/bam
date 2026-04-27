/**
 * Cursor management with atomic block-write semantics (red-team C-7).
 *
 * The Reader's per-block writes (`upsertBatch`, `upsertObserved`) and
 * the cursor advance (`setCursor`) MUST land in the same `bam-store`
 * transaction. A crash between the two would leave durable rows under
 * a still-pre-block cursor, and a re-run would re-write them — or,
 * worse, advance the cursor past rows that never landed.
 *
 * `commitBlock` enforces this shape: the caller passes a `writes`
 * callback that performs all per-block row mutations against the
 * provided `StoreTxn`; on successful return, `commitBlock` calls
 * `setCursor` from inside the same transaction. Any throw inside
 * `writes` propagates out of `withTxn` — neither rows nor the cursor
 * are persisted (sqlite/Postgres rollback semantics).
 */

import type { BamStore, ReaderCursorRow, StoreTxn } from 'bam-store';

export interface CommitBlockArgs {
  chainId: number;
  /** Block being committed. After success, cursor advances to `(blockNumber, lastTxIndex)`. */
  blockNumber: number;
  /** TxIndex of the last `BlobBatchRegistered` event processed in the block. */
  lastTxIndex: number;
  /** Per-block row writes — must use the supplied `txn`. */
  writes: (txn: StoreTxn) => Promise<void>;
  /** Wallclock at commit time, ms since epoch. Default `Date.now()`. */
  now?: () => number;
}

/**
 * Apply `writes` and advance the cursor in a single store transaction.
 * Returns when the transaction commits; throws if any write fails or
 * if `setCursor` itself fails — in either case neither writes nor
 * cursor advance persist.
 */
export async function commitBlock(
  store: BamStore,
  args: CommitBlockArgs
): Promise<void> {
  const now = args.now ?? Date.now;
  await store.withTxn(async (txn) => {
    await args.writes(txn);
    const row: ReaderCursorRow = {
      chainId: args.chainId,
      lastBlockNumber: args.blockNumber,
      lastTxIndex: args.lastTxIndex,
      updatedAt: now(),
    };
    await txn.setCursor(row);
  });
}

/** Read the current cursor for `chainId`. Returns `null` if unset. */
export async function getCursor(
  store: BamStore,
  chainId: number
): Promise<ReaderCursorRow | null> {
  return store.withTxn((txn) => txn.getCursor(chainId));
}
