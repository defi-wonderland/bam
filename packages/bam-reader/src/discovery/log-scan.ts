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
}

function toNumber(v: bigint | number): number {
  return typeof v === 'bigint' ? Number(v) : v;
}

/**
 * Fetch and order all `BlobBatchRegistered` events emitted by
 * `bamCoreAddress` in `[fromBlock, toBlock]`. With a non-empty
 * `contentTags` allowlist, only events whose indexed `contentTag`
 * is in the set are returned.
 */
export async function scanLogs(
  opts: ScanLogsOptions
): Promise<BlobBatchRegisteredEvent[]> {
  if (opts.fromBlock > opts.toBlock) return [];

  const filterTags =
    opts.contentTags && opts.contentTags.length > 0 ? opts.contentTags : undefined;

  const raw = await opts.publicClient.getLogs({
    address: opts.bamCoreAddress,
    event: BLOB_BATCH_REGISTERED_EVENT,
    args: filterTags ? { contentTag: filterTags } : undefined,
    fromBlock: BigInt(opts.fromBlock),
    toBlock: BigInt(opts.toBlock),
  });

  const events: BlobBatchRegisteredEvent[] = raw.map((log) => ({
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

  events.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
    return a.logIndex - b.logIndex;
  });
  return events;
}
