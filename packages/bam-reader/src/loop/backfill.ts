/**
 * Backfill mode wiring + retention classification (red-team C-9).
 *
 * Iterates `[fromBlock, toBlock]` in chunks, calling `processBatch`
 * once per scanned `BlobBatchRegistered` event. The cursor is
 * advanced per block in the same way as the live-tail loop, so a
 * subsequent `serve` call resumes seamlessly.
 *
 * Retention classification: when `processBatch` reports
 * `outcome === 'unreachable'`, classify it as **permanent** when the
 * batch's L1 block age (head − blockNumber) exceeds
 * `retentionThresholdBlocks` (default ≈ 18 days × 7200 blocks/day),
 * **transient** otherwise. The classification is reported in the
 * returned counters so operators can grep distinctly.
 */

import type { Address, Bytes32 } from 'bam-sdk';

import { commitBlock } from '../discovery/cursor.js';
import {
  scanLogs,
  type BlobBatchRegisteredEvent,
} from '../discovery/log-scan.js';
import {
  processBatch,
  type ProcessBatchResult,
} from './process-batch.js';
import type { LiveTailL1Client } from './live-tail.js';
import type { BamStore } from 'bam-store';
import type { ReaderCounters, ReaderEvent } from '../types.js';
import type { ReadContractClient } from '../decode/on-chain-decoder.js';
import type { VerifyReadContractClient } from '../verify/on-chain-registry.js';
import type { FetchLike } from '../blob-fetch/beacon.js';

/** ~18 days × 7200 blocks/day; matches the L1 sidecar retention window. */
export const DEFAULT_RETENTION_THRESHOLD_BLOCKS = 18 * 7200;

export interface BackfillOptions {
  store: BamStore;
  l1: LiveTailL1Client;
  chainId: number;
  bamCoreAddress: Address;
  contentTags?: Bytes32[];
  fromBlock: number;
  toBlock: number;
  /**
   * Default per-`eth_getLogs` chunk size. Operator-facing knob is
   * `READER_LOG_SCAN_CHUNK_BLOCKS` (parsed into `ReaderConfig`).
   * `chunkSize` (legacy in-process override) wins when both are set.
   */
  logScanChunkBlocks: number;
  /** Backfill progress: minimum interval between events, ms. */
  progressIntervalMs: number;
  /** Backfill progress: minimum chunks between events. */
  progressEveryChunks: number;
  /** Legacy in-process override for chunk size. Wins over `logScanChunkBlocks`. */
  chunkSize?: number;
  retentionThresholdBlocks?: number;
  ethCallGasCap: bigint;
  ethCallTimeoutMs: number;
  sources: { beaconUrl?: string; blobscanUrl?: string };
  decodePublicClient?: ReadContractClient;
  verifyPublicClient?: VerifyReadContractClient;
  fetchImpl?: FetchLike;
  counters: ReaderCounters;
  logger?: (event: ReaderEvent) => void;
  now?: () => number;
  /** Test injection. */
  processBatchImpl?: typeof processBatch;
}

export interface BackfillCounters {
  scanned: number;
  processed: number;
  permanentUnreachable: number;
  transientUnreachable: number;
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
 * Run a one-shot backfill over `[fromBlock, toBlock]`. Re-running the
 * same range is idempotent: `upsertBatch` / `upsertObserved` preserve
 * prior values on re-write, the cursor advance is monotonic, and
 * decode/verify dispatches are pure functions of the input.
 */
export async function backfill(opts: BackfillOptions): Promise<BackfillCounters> {
  if (opts.fromBlock > opts.toBlock) {
    return {
      scanned: 0,
      processed: 0,
      permanentUnreachable: 0,
      transientUnreachable: 0,
    };
  }
  const chunkSize = Math.max(1, opts.chunkSize ?? opts.logScanChunkBlocks);
  const retentionThreshold =
    opts.retentionThresholdBlocks ?? DEFAULT_RETENTION_THRESHOLD_BLOCKS;
  const progressIntervalMs = Math.max(1, opts.progressIntervalMs);
  const progressEveryChunks = Math.max(1, opts.progressEveryChunks);
  const nowMs: () => number = opts.now ?? Date.now;
  const head = Number(await opts.l1.getBlockNumber());
  // Clamp `toBlock` against current head so the cursor never advances
  // ahead of the chain — a future cursor would silently skip blocks
  // mined later (cubic finding). Backfill is a one-shot historical
  // pass; advancing into the future has no legitimate use.
  const effectiveToBlock = Math.min(opts.toBlock, head);
  if (opts.fromBlock > effectiveToBlock) {
    return {
      scanned: 0,
      processed: 0,
      permanentUnreachable: 0,
      transientUnreachable: 0,
    };
  }
  const proc = opts.processBatchImpl ?? processBatch;

  let scanned = 0;
  let processed = 0;
  let permanentUnreachable = 0;
  let transientUnreachable = 0;
  let lastEmittedAt = nowMs();
  let chunksSinceLastEmit = 0;
  let lastChunkTo = opts.fromBlock;

  const emitProgress = (): void => {
    opts.logger?.({
      kind: 'backfill_progress',
      fromBlock: opts.fromBlock,
      toBlock: effectiveToBlock,
      currentBlock: lastChunkTo,
      scanned,
      processed,
    });
    lastEmittedAt = nowMs();
    chunksSinceLastEmit = 0;
  };

  for (let chunkFrom = opts.fromBlock; chunkFrom <= effectiveToBlock; chunkFrom += chunkSize) {
    const chunkTo = Math.min(chunkFrom + chunkSize - 1, effectiveToBlock);
    const events = await scanLogs({
      publicClient: opts.l1,
      bamCoreAddress: opts.bamCoreAddress,
      fromBlock: chunkFrom,
      toBlock: chunkTo,
      contentTags: opts.contentTags,
    });
    scanned += events.length;

    const byBlock = groupByBlock(events);
    const sortedBlocks = Array.from(byBlock.keys()).sort((a, b) => a - b);
    for (const blockNumber of sortedBlocks) {
      const blockEvents = byBlock.get(blockNumber)!;
      blockEvents.sort((a, b) => a.logIndex - b.logIndex);
      const header = await opts.l1.getBlockHeader(blockNumber);
      const { parentBeaconBlockRoot, timestampUnixSec: l1IncludedAtUnixSec } = header;
      let maxTxIndex = 0;
      for (const event of blockEvents) {
        const result: ProcessBatchResult = await proc({
          event,
          parentBeaconBlockRoot,
          l1IncludedAtUnixSec,
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
        });
        if (result.txIndex > maxTxIndex) maxTxIndex = result.txIndex;
        processed += 1;

        if (result.outcome === 'unreachable') {
          const age = head - event.blockNumber;
          if (age > retentionThreshold) {
            permanentUnreachable += 1;
            opts.logger?.({
              kind: 'blob_unreachable',
              txHash: event.txHash,
              versionedHash: event.versionedHash,
              classification: 'permanent',
            });
          } else {
            transientUnreachable += 1;
          }
        }
      }
      await commitBlock(opts.store, {
        chainId: opts.chainId,
        blockNumber,
        lastTxIndex: maxTxIndex,
        writes: async () => {},
        now: opts.now,
      });
      opts.logger?.({ kind: 'cursor_advanced', chainId: opts.chainId, blockNumber });
    }
    // Advance cursor to the chunk's upper bound even if it had no events,
    // so a re-run skips empty ranges.
    const lastSeenBlock = sortedBlocks[sortedBlocks.length - 1] ?? -1;
    if (lastSeenBlock < chunkTo) {
      await commitBlock(opts.store, {
        chainId: opts.chainId,
        blockNumber: chunkTo,
        lastTxIndex: 0,
        writes: async () => {},
        now: opts.now,
      });
    }
    lastChunkTo = chunkTo;
    chunksSinceLastEmit += 1;
    if (
      nowMs() - lastEmittedAt >= progressIntervalMs ||
      chunksSinceLastEmit >= progressEveryChunks
    ) {
      emitProgress();
    }
  }
  // Closing event: always emit one progress event at completion so
  // consumers see a final snapshot regardless of cadence config.
  emitProgress();

  return { scanned, processed, permanentUnreachable, transientUnreachable };
}
