/**
 * Live-tail loop wiring.
 *
 * Each tick:
 *   1. Read the chain head from the public client.
 *   2. Compute the safe scan upper bound: `head - reorgWindowBlocks`.
 *   3. Read the cursor for `chainId` (or treat as `fromBlock - 1`
 *      when unset; first-time deployments take a configured
 *      `startBlock` to avoid scanning from genesis).
 *   4. `scanLogs([cursor + 1, safeHead])` for `BlobBatchRegistered`.
 *   5. Group events by block; for each block in order:
 *      - Fetch parent-beacon-block-root + tx receipt for each event.
 *      - Run `processBatch` for each event.
 *      - Advance the cursor to that block's `(blockNumber, maxTxIndex)`
 *        in the same store transaction as the writes (red-team C-7).
 *   6. Run a single reorg-watcher tick.
 *
 * The loop is best-effort 1-block-behind-head in steady state; on
 * outage it picks up from the cursor without duplicating writes
 * (substrate `upsertBatch` / `upsertObserved` are idempotent).
 */

import type { Address, Bytes32 } from 'bam-sdk';
import type { BamStore, StoreTxn } from 'bam-store';

import { commitBlock, getCursor } from '../discovery/cursor.js';
import {
  scanLogs,
  type BlobBatchRegisteredEvent,
  type LogScanClient,
} from '../discovery/log-scan.js';
import {
  processBatch,
  type ProcessBatchOptions,
  type ProcessBatchResult,
} from './process-batch.js';
import {
  ReaderReorgWatcher,
  type BlockSource,
} from '../reorg-watcher.js';
import type { ReaderCounters, ReaderEvent } from '../types.js';
import type { ReadContractClient } from '../decode/on-chain-decoder.js';
import type { VerifyReadContractClient } from '../verify/on-chain-registry.js';
import type { FetchLike } from '../blob-fetch/beacon.js';

export interface LiveTailL1Client extends LogScanClient, BlockSource {
  /** Returns the parent_beacon_block_root for `blockNumber`, or `null` if unavailable. */
  getParentBeaconBlockRoot(blockNumber: number): Promise<Bytes32 | null>;
  /** Used at construction-time chain-id validation (red-team C-3). */
  getChainId(): Promise<number>;
}

export interface LiveTailOptions {
  store: BamStore;
  l1: LiveTailL1Client;
  chainId: number;
  bamCoreAddress: Address;
  contentTags?: Bytes32[];
  reorgWindowBlocks: number;
  /** Default cursor for first-time-run when no cursor row exists. */
  startBlock: number;
  ethCallGasCap: bigint;
  ethCallTimeoutMs: number;
  sources: { beaconUrl?: string; blobscanUrl?: string };
  decodePublicClient?: ReadContractClient;
  verifyPublicClient?: VerifyReadContractClient;
  fetchImpl?: FetchLike;
  counters: ReaderCounters;
  logger?: (event: ReaderEvent) => void;
  now?: () => number;
  /** Test injection for the per-batch worker. */
  processBatchImpl?: typeof processBatch;
  /** Test injection for the reorg watcher. */
  reorgWatcher?: { tick(): Promise<{ reorgedCount: number; keptCount: number }> };
}

export interface TickResult {
  fromBlock: number;
  toBlock: number;
  scanned: number;
  processed: number;
  reorgedCount: number;
  keptCount: number;
}

function groupByBlock(
  events: BlobBatchRegisteredEvent[]
): Map<number, BlobBatchRegisteredEvent[]> {
  const out = new Map<number, BlobBatchRegisteredEvent[]>();
  for (const e of events) {
    const arr = out.get(e.blockNumber) ?? [];
    arr.push(e);
    out.set(e.blockNumber, arr);
  }
  return out;
}

/**
 * One iteration of the live-tail loop. Returns the range scanned and
 * counts of processed events. The caller (a daemon) should call this
 * on a timer and stop on SIGINT/SIGTERM.
 */
export async function liveTailTick(opts: LiveTailOptions): Promise<TickResult> {
  const head = Number(await opts.l1.getBlockNumber());
  const safeHead = head - opts.reorgWindowBlocks;
  const cursor = await getCursor(opts.store, opts.chainId);
  const fromBlock = cursor ? cursor.lastBlockNumber + 1 : opts.startBlock;
  const toBlock = safeHead;

  if (fromBlock > toBlock) {
    return { fromBlock, toBlock, scanned: 0, processed: 0, reorgedCount: 0, keptCount: 0 };
  }

  const events = await scanLogs({
    publicClient: opts.l1,
    bamCoreAddress: opts.bamCoreAddress,
    fromBlock,
    toBlock,
    contentTags: opts.contentTags,
  });

  const byBlock = groupByBlock(events);
  const sortedBlocks = Array.from(byBlock.keys()).sort((a, b) => a - b);
  const proc = opts.processBatchImpl ?? processBatch;

  let processed = 0;
  // Stop advancing the cursor at the first block that hit a transient
  // unreachable. The next tick will re-scan from there, giving the
  // beacon/Blobscan source a chance to come back. Without this, a
  // transient outage becomes a permanent gap (qodo finding).
  let lastCommittedBlock: number | null = null;
  let blockedByTransient = false;
  for (const blockNumber of sortedBlocks) {
    if (blockedByTransient) break;
    const blockEvents = byBlock.get(blockNumber)!;
    blockEvents.sort((a, b) => a.logIndex - b.logIndex);
    const parentBeaconBlockRoot = await opts.l1.getParentBeaconBlockRoot(blockNumber);
    let maxTxIndex = 0;
    let blockHasTransient = false;
    for (const event of blockEvents) {
      const result: ProcessBatchResult = await proc(buildProcessOpts(opts, event, parentBeaconBlockRoot));
      if (result.txIndex > maxTxIndex) maxTxIndex = result.txIndex;
      processed += 1;
      // Live-tail has no retention threshold to consult: every
      // unreachable here is treated as transient. Backfill mode (which
      // does have an age signal) classifies separately.
      if (result.outcome === 'unreachable') blockHasTransient = true;
    }
    if (blockHasTransient) {
      blockedByTransient = true;
      break;
    }
    // Advance cursor inside its own txn after the per-batch writes have
    // landed. The processBatch implementation already runs each batch's
    // upsert inside its own withTxn; the cursor write is a separate but
    // immediate follow-up. (A future optimisation could run all of
    // a block's writes inside one withTxn — see follow-up note in
    // `cursor.ts`.)
    await commitBlock(opts.store, {
      chainId: opts.chainId,
      blockNumber,
      lastTxIndex: maxTxIndex,
      writes: async (_txn: StoreTxn) => {},
      now: opts.now,
    });
    lastCommittedBlock = blockNumber;
    opts.logger?.({ kind: 'cursor_advanced', chainId: opts.chainId, blockNumber });
  }

  // Catch-up: if no events landed at the upper bound but the head has
  // advanced past the cursor, advance the cursor to `toBlock` so we
  // don't re-scan empty ranges next tick. Skipped if a transient
  // unreachable parked us before the upper bound — we want to re-try.
  const allEventsCommitted =
    !blockedByTransient &&
    (sortedBlocks.length === 0 ||
      lastCommittedBlock === sortedBlocks[sortedBlocks.length - 1]);
  if (allEventsCommitted && (lastCommittedBlock ?? -1) < toBlock) {
    // The catch-up advance lands at `toBlock`, which had no event.
    // `lastTxIndex = 0` is the correct sentinel for an empty block —
    // reusing the prior block's max would tag the cursor with a tx
    // index that doesn't belong to `toBlock` (cubic finding).
    await commitBlock(opts.store, {
      chainId: opts.chainId,
      blockNumber: toBlock,
      lastTxIndex: 0,
      writes: async () => {},
      now: opts.now,
    });
  }

  const watcher =
    opts.reorgWatcher ??
    new ReaderReorgWatcher({
      store: opts.store,
      blockSource: opts.l1,
      chainId: opts.chainId,
      reorgWindowBlocks: opts.reorgWindowBlocks,
    });
  const watch = await watcher.tick();
  return {
    fromBlock,
    toBlock,
    scanned: events.length,
    processed,
    reorgedCount: watch.reorgedCount,
    keptCount: watch.keptCount,
  };
}

function buildProcessOpts(
  opts: LiveTailOptions,
  event: BlobBatchRegisteredEvent,
  parentBeaconBlockRoot: Bytes32 | null
): ProcessBatchOptions {
  return {
    event,
    parentBeaconBlockRoot,
    store: opts.store,
    sources: opts.sources,
    chainId: opts.chainId,
    decodePublicClient: opts.decodePublicClient,
    verifyPublicClient: opts.verifyPublicClient,
    ethCallGasCap: opts.ethCallGasCap,
    ethCallTimeoutMs: opts.ethCallTimeoutMs,
    fetchImpl: opts.fetchImpl,
    counters: opts.counters,
    logger: opts.logger,
    now: opts.now,
  };
}
