/**
 * `eth_getLogs` scanner over a block range.
 *
 * Returns the `BlobBatchRegistered` events emitted by the configured
 * BAM Core address in canonical `(blockNumber, logIndex)` order.
 * Optional `contentTags` allowlist narrows the scan via the indexed
 * `contentTag` topic — passing an empty array is allowed but
 * functionally equivalent to passing nothing (no filter).
 */

import { FIELD_ELEMENTS_PER_BLOB } from 'bam-sdk';
import type { Address, Bytes32 } from 'bam-sdk';

export const BLOB_BATCH_REGISTERED_EVENT = {
  type: 'event',
  name: 'BlobBatchRegistered',
  inputs: [
    { name: 'versionedHash', type: 'bytes32', indexed: true },
    { name: 'submitter', type: 'address', indexed: true },
    { name: 'contentTag', type: 'bytes32', indexed: true },
    { name: 'decoder', type: 'address', indexed: false },
    { name: 'signatureRegistry', type: 'address', indexed: false },
  ],
  anonymous: false,
} as const;

/**
 * Sibling event emitted by `declareBlobSegment` (the inner ERC-BSS hop
 * inside `registerBlobBatch` / `registerBlobBatches`). Carries the per-
 * tag `(startFE, endFE)` that `BlobBatchRegistered` does not.
 *
 * The Reader fetches both events for every scan range and joins them
 * by `(txHash, contentTag)` so that a packed multi-segment blob slices
 * to the correct per-tag bytes before decode.
 */
export const BLOB_SEGMENT_DECLARED_EVENT = {
  type: 'event',
  name: 'BlobSegmentDeclared',
  inputs: [
    { name: 'versionedHash', type: 'bytes32', indexed: true },
    { name: 'declarer', type: 'address', indexed: true },
    { name: 'startFE', type: 'uint16', indexed: false },
    { name: 'endFE', type: 'uint16', indexed: false },
    { name: 'contentTag', type: 'bytes32', indexed: true },
  ],
  anonymous: false,
} as const;

export interface BlobBatchRegisteredEvent {
  /** L1 block number where the event was emitted. */
  blockNumber: number;
  /** Position of the emitting tx within the block. */
  txIndex: number;
  /** Position of the log within the tx (used for canonical ordering). */
  logIndex: number;
  /** Tx hash of the emitting transaction. */
  txHash: Bytes32;
  versionedHash: Bytes32;
  submitter: Address;
  contentTag: Bytes32;
  decoder: Address;
  signatureRegistry: Address;
  /**
   * Per-tag segment range, joined from the same-tx `BlobSegmentDeclared`
   * event by `(txHash, contentTag)`. Optional: defaults to the full-blob
   * range `[0, FIELD_ELEMENTS_PER_BLOB)` when no matching segment event
   * is observed in the same range (pre-feature on-chain history; or a
   * caller that has not migrated to the dual-event scanner). Range
   * validation (`validateSegmentRange`) is the chokepoint that rejects
   * malformed inputs before any byte slicing or store write.
   */
  startFE?: number;
  endFE?: number;
}

/** Common log envelope shared by both event types. */
interface ScannerLogEnvelope {
  blockNumber: bigint | number;
  transactionIndex: bigint | number;
  logIndex: bigint | number;
  transactionHash: Bytes32;
}

export type ScannerBatchLog = ScannerLogEnvelope & {
  eventName: 'BlobBatchRegistered';
  args: {
    versionedHash: Bytes32;
    submitter: Address;
    contentTag: Bytes32;
    decoder: Address;
    signatureRegistry: Address;
  };
};

export type ScannerSegmentLog = ScannerLogEnvelope & {
  eventName: 'BlobSegmentDeclared';
  args: {
    versionedHash: Bytes32;
    declarer: Address;
    startFE: number;
    endFE: number;
    contentTag: Bytes32;
  };
};

export type ScannerLog = ScannerBatchLog | ScannerSegmentLog;

/**
 * Combined `eth_getLogs` adapter. The scanner asks for both event
 * types in one round-trip — providers OR the topic[0] filter
 * server-side, so a single call returns logs of either kind.
 *
 * Implementations must populate `eventName` so the scanner can
 * discriminate without re-decoding by topic[0]. Tag filtering, when
 * supplied, applies to topic[3] which is `contentTag` on both events.
 */
export interface LogScanClient {
  getLogs(args: {
    address: Address;
    events: readonly [
      typeof BLOB_BATCH_REGISTERED_EVENT,
      typeof BLOB_SEGMENT_DECLARED_EVENT,
    ];
    args?: { contentTag?: readonly Bytes32[] };
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<ScannerLog[]>;
}

export interface ScanLogsOptions {
  publicClient: LogScanClient;
  bamCoreAddress: Address;
  fromBlock: number;
  toBlock: number;
  contentTags?: Bytes32[];
  /**
   * When set and the requested range exceeds it, page the range
   * into back-to-back slices of this many blocks. When the range
   * fits in one chunk, exactly one `getLogs` call is issued —
   * preserving the steady-state live-tail's single-RPC-per-tick
   * behavior.
   */
  chunkSize?: number;
}

function toNumber(v: bigint | number): number {
  return typeof v === 'bigint' ? Number(v) : v;
}

/**
 * Minimum chunk size below which adaptive halving stops and the
 * provider error is rethrown to the caller. Documented in
 * `docs/specs/features/008-reader-scan-ergonomics/plan.md` §*Security
 * impact* (gate G-6). Exported so tests can pin the bound.
 */
export const MIN_CHUNK_BLOCKS = 64;

/**
 * Patterns surfaced by public RPC providers when an `eth_getLogs`
 * range / result-set exceeds their cap. Treated as one error family —
 * "the chunk was too big, retry smaller". Other errors (timeouts,
 * rate limits, transient 5xx) bubble out unchanged.
 */
const RANGE_TOO_LARGE_PATTERNS = [
  /block range is too large/i,
  /block range too large/i,
  /log response size exceeded/i,
  /response size exceeded/i,
  /query returned more than/i,
  /more than \d+ results/i,
  /exceeds.*(?:result|response|range|log|block)\s*(?:limit|size|cap)/i,
];

function isRangeTooLargeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return RANGE_TOO_LARGE_PATTERNS.some((re) => re.test(msg));
}

/**
 * Pair each `BlobBatchRegistered` log with its corresponding
 * `BlobSegmentDeclared` log, scoped to the same transaction.
 *
 * The BAM Core contract emits the two as a tightly-coupled pair inside
 * `registerBlobBatch(es)`: BSD first (from the inner `declareBlobSegment`
 * hop), then BBR. Within a single tx, the n-th BBR's range is carried by
 * the most recent BSD — preceding the BBR in log order — that has not
 * already been claimed by an earlier BBR and matches on
 * `(versionedHash, contentTag)`.
 *
 * Walking by `logIndex` and matching most-recent-first (LIFO) is what
 * makes this robust against hostile injections:
 *
 *   - `declareBlobSegment` is publicly callable on BAM Core. A
 *     multicall tx could emit a "rogue" BSD outside any
 *     `registerBlobBatch(es)` frame.
 *   - A leading rogue BSD followed by a legitimate BSD→BBR pair would
 *     fool a content-keyed last-wins join into pointing the BBR at the
 *     rogue range. Positional LIFO pairing claims the legitimate BSD
 *     first; the rogue BSD is left unconsumed and ignored.
 *   - A trailing rogue BSD (with no following BBR) is similarly
 *     ignored.
 *   - `registerBlobBatches([{tagA, A}, {tagA, B}])` with a duplicate
 *     tag emits BSD_A→BBR_A→BSD_B→BBR_B; each BBR claims its own BSD
 *     by recency. (The Poster's aggregator never produces such a pack
 *     — but the contract permits it.)
 *
 * Returns a per-BBR-index → range map; absent entries fall back to the
 * full-blob default in the caller.
 */
function pairSegmentRanges(
  batchLogs: readonly ScannerBatchLog[],
  segmentLogs: readonly ScannerSegmentLog[]
): Map<number, { startFE: number; endFE: number }> {
  // Common case (pre-feature on-chain history; stub clients): no
  // segment events to pair, every BBR falls back to the default range.
  if (segmentLogs.length === 0) {
    return new Map();
  }

  // Pre-lowercase BSD comparison fields once at push time; the LIFO
  // match below scans the pending stack and would otherwise lowercase
  // them per BBR per pending entry.
  interface PendingBSD {
    log: ScannerSegmentLog;
    vhLower: string;
    tagLower: string;
  }
  type TxItem =
    | { kind: 'bbr'; idx: number; logIndex: number; log: ScannerBatchLog }
    | { kind: 'bsd'; logIndex: number; bsd: PendingBSD };

  const byTx = new Map<string, TxItem[]>();
  for (let i = 0; i < batchLogs.length; i++) {
    const log = batchLogs[i]!;
    const key = log.transactionHash.toLowerCase();
    const arr = byTx.get(key) ?? [];
    arr.push({ kind: 'bbr', idx: i, logIndex: toNumber(log.logIndex), log });
    byTx.set(key, arr);
  }
  for (const log of segmentLogs) {
    const key = log.transactionHash.toLowerCase();
    const arr = byTx.get(key) ?? [];
    arr.push({
      kind: 'bsd',
      logIndex: toNumber(log.logIndex),
      bsd: {
        log,
        vhLower: log.args.versionedHash.toLowerCase(),
        tagLower: log.args.contentTag.toLowerCase(),
      },
    });
    byTx.set(key, arr);
  }

  const result = new Map<number, { startFE: number; endFE: number }>();
  for (const items of byTx.values()) {
    items.sort((a, b) => a.logIndex - b.logIndex);
    const pending: PendingBSD[] = [];
    for (const item of items) {
      if (item.kind === 'bsd') {
        pending.push(item.bsd);
        continue;
      }
      const targetVH = item.log.args.versionedHash.toLowerCase();
      const targetTag = item.log.args.contentTag.toLowerCase();
      for (let j = pending.length - 1; j >= 0; j--) {
        const bsd = pending[j]!;
        if (bsd.vhLower === targetVH && bsd.tagLower === targetTag) {
          result.set(item.idx, {
            startFE: Number(bsd.log.args.startFE),
            endFE: Number(bsd.log.args.endFE),
          });
          pending.splice(j, 1);
          break;
        }
      }
    }
  }
  return result;
}

async function fetchRange(
  opts: ScanLogsOptions,
  fromBlock: number,
  toBlock: number
): Promise<BlobBatchRegisteredEvent[]> {
  const filterTags =
    opts.contentTags && opts.contentTags.length > 0 ? opts.contentTags : undefined;

  // One combined `eth_getLogs` call returns both event types via the
  // OR'd topic[0] filter the provider applies server-side.
  // `BlobBatchRegistered` carries the decoder/registry plumbing;
  // `BlobSegmentDeclared` carries the per-tag `(startFE, endFE)`
  // range needed to slice a packed multi-segment blob. They are paired
  // below per-tx by log-order with LIFO matching on
  // `(versionedHash, contentTag)` — robust against duplicates and
  // same-tx hostile `declareBlobSegment` injections.
  const logs = await opts.publicClient.getLogs({
    address: opts.bamCoreAddress,
    events: [BLOB_BATCH_REGISTERED_EVENT, BLOB_SEGMENT_DECLARED_EVENT],
    args: filterTags ? { contentTag: filterTags } : undefined,
    fromBlock: BigInt(fromBlock),
    toBlock: BigInt(toBlock),
  });

  const batchLogs: ScannerBatchLog[] = [];
  const segmentLogs: ScannerSegmentLog[] = [];
  for (const log of logs) {
    if (log.eventName === 'BlobBatchRegistered') {
      batchLogs.push(log);
    } else {
      segmentLogs.push(log);
    }
  }

  const ranges = pairSegmentRanges(batchLogs, segmentLogs);

  return batchLogs.map((log, i) => {
    const range = ranges.get(i);
    return {
      blockNumber: toNumber(log.blockNumber),
      txIndex: toNumber(log.transactionIndex),
      logIndex: toNumber(log.logIndex),
      txHash: log.transactionHash,
      versionedHash: log.args.versionedHash,
      submitter: log.args.submitter,
      contentTag: log.args.contentTag,
      decoder: log.args.decoder,
      signatureRegistry: log.args.signatureRegistry,
      // Pre-feature history / stub clients with no BSD: fall back to
      // the full-blob default. `validateSegmentRange` is the
      // downstream chokepoint.
      startFE: range?.startFE ?? 0,
      endFE: range?.endFE ?? FIELD_ELEMENTS_PER_BLOB,
    };
  });
}

/**
 * Fetch a chunk with adaptive halving on "range too large" /
 * "result too large" provider errors. On a matching error, the
 * chunk is split in half and the two halves are retried
 * recursively. Bounded by `MIN_CHUNK_BLOCKS`: if a chunk at the
 * minimum size still throws the family error, the error
 * rethrows to the caller. Non-matching errors rethrow
 * immediately (gate G-6).
 */
async function fetchWithHalving(
  opts: ScanLogsOptions,
  fromBlock: number,
  toBlock: number
): Promise<BlobBatchRegisteredEvent[]> {
  try {
    return await fetchRange(opts, fromBlock, toBlock);
  } catch (err) {
    if (!isRangeTooLargeError(err)) throw err;
    const span = toBlock - fromBlock + 1;
    if (span <= MIN_CHUNK_BLOCKS) throw err;
    const mid = fromBlock + Math.floor(span / 2) - 1;
    const left = await fetchWithHalving(opts, fromBlock, mid);
    const right = await fetchWithHalving(opts, mid + 1, toBlock);
    return left.concat(right);
  }
}

/**
 * Fetch and order all `BlobBatchRegistered` events emitted by
 * `bamCoreAddress` in `[fromBlock, toBlock]`. With a non-empty
 * `contentTags` allowlist, only events whose indexed `contentTag`
 * is in the set are returned.
 *
 * When `chunkSize` is set and the range exceeds it, the call is
 * paged into back-to-back chunks; results are concatenated and
 * re-sorted into canonical `(blockNumber, logIndex)` order. Each
 * chunk is fetched via `fetchWithHalving` so a single oversized
 * chunk recovers automatically by splitting smaller.
 */
export async function scanLogs(
  opts: ScanLogsOptions
): Promise<BlobBatchRegisteredEvent[]> {
  if (opts.chunkSize !== undefined) {
    if (!Number.isInteger(opts.chunkSize) || opts.chunkSize < 1) {
      throw new TypeError(
        `scanLogs.chunkSize must be a positive integer, got ${opts.chunkSize}`
      );
    }
  }
  if (opts.fromBlock > opts.toBlock) return [];

  const chunkSize = opts.chunkSize;
  const rangeLen = opts.toBlock - opts.fromBlock + 1;

  let events: BlobBatchRegisteredEvent[];
  if (chunkSize === undefined || rangeLen <= chunkSize) {
    events = await fetchWithHalving(opts, opts.fromBlock, opts.toBlock);
  } else {
    events = [];
    for (let from = opts.fromBlock; from <= opts.toBlock; from += chunkSize) {
      const to = Math.min(from + chunkSize - 1, opts.toBlock);
      const chunk = await fetchWithHalving(opts, from, to);
      events.push(...chunk);
    }
  }

  events.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
    return a.logIndex - b.logIndex;
  });
  return events;
}
