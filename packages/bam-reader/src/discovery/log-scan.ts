/**
 * `eth_getLogs` scanner over a block range.
 *
 * Returns the `BlobBatchRegistered` events emitted by the configured
 * BAM Core address in canonical `(blockNumber, logIndex)` order.
 * Optional `contentTags` allowlist narrows the scan via the indexed
 * `contentTag` topic — passing an empty array is allowed but
 * functionally equivalent to passing nothing (no filter).
 */

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
}

export interface LogScanClient {
  getLogs(args: {
    address: Address;
    event: typeof BLOB_BATCH_REGISTERED_EVENT;
    args?: { contentTag?: readonly Bytes32[] };
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<
    Array<{
      blockNumber: bigint | number;
      transactionIndex: bigint | number;
      logIndex: bigint | number;
      transactionHash: Bytes32;
      args: {
        versionedHash: Bytes32;
        submitter: Address;
        contentTag: Bytes32;
        decoder: Address;
        signatureRegistry: Address;
      };
    }>
  >;
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

async function fetchRange(
  opts: ScanLogsOptions,
  fromBlock: number,
  toBlock: number
): Promise<BlobBatchRegisteredEvent[]> {
  const filterTags =
    opts.contentTags && opts.contentTags.length > 0 ? opts.contentTags : undefined;

  const raw = await opts.publicClient.getLogs({
    address: opts.bamCoreAddress,
    event: BLOB_BATCH_REGISTERED_EVENT,
    args: filterTags ? { contentTag: filterTags } : undefined,
    fromBlock: BigInt(fromBlock),
    toBlock: BigInt(toBlock),
  });

  return raw.map((log) => ({
    blockNumber: toNumber(log.blockNumber),
    txIndex: toNumber(log.transactionIndex),
    logIndex: toNumber(log.logIndex),
    txHash: log.transactionHash,
    versionedHash: log.args.versionedHash,
    submitter: log.args.submitter,
    contentTag: log.args.contentTag,
    decoder: log.args.decoder,
    signatureRegistry: log.args.signatureRegistry,
  }));
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
  if (opts.fromBlock > opts.toBlock) return [];

  const chunkSize =
    opts.chunkSize !== undefined && opts.chunkSize > 0 ? opts.chunkSize : undefined;
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
