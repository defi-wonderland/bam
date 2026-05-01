import type { Address, Bytes32 } from 'bam-sdk';

import type { DecodedMessage } from '../types.js';
import type { PackResult } from './aggregator.js';

/**
 * Per-tag entry in a packed-submission outcome. One per included tag.
 */
export interface PackedSubmitIncludedEntry {
  contentTag: Bytes32;
  startFE: number;
  endFE: number;
  messages: DecodedMessage[];
}

/**
 * Outcome of a packed `registerBlobBatches` submission.
 *
 * The chain-coordinate fields (`txHash`, `blockNumber`, `txIndex`) are
 * shared across every included tag — one type-3 tx → one receipt → N
 * `BlobBatchRegistered` events → N `BatchRow`s in `bam-store`.
 */
export type PackedSubmitOutcome =
  | {
      kind: 'included';
      txHash: Bytes32;
      blockNumber: number;
      txIndex: number;
      blobVersionedHash: Bytes32;
      submitter: Address;
      entries: PackedSubmitIncludedEntry[];
    }
  | { kind: 'retryable'; detail: string }
  | { kind: 'permanent'; detail: string };

/**
 * Multi-tag (packed) submission entrypoint. Accepts a `PackResult`
 * from the aggregator (T019); assembles the multi-segment blob, runs
 * the runtime self-check (T020), and submits one type-3 transaction
 * calling the BAM Core's `registerBlobBatches` entrypoint. Atomicity
 * falls out of the contract design — every per-tag event lands
 * together or the whole tx reverts.
 */
export interface BuildAndSubmitMulti {
  (args: { pack: PackResult }): Promise<PackedSubmitOutcome>;
}
