/**
 * Per-batch processing pipeline.
 *
 * Wires:  blob fetch (multi-source) → decode dispatch → per-message
 * verify dispatch → bam-store writes (`upsertBatch` + `upsertObserved`).
 *
 * Failure modes:
 *  - Blob unreachable (all sources null) → write `BatchRow` with empty
 *    `messageSnapshot`; no `MessageRow` writes. Increments
 *    `undecodable`. Caller classifies permanent vs transient via age.
 *  - Structural decode failure (`RangeError` from the SDK or the bound
 *    check in dispatch) → write `BatchRow` with empty `messageSnapshot`;
 *    no `MessageRow` writes. Increments `skippedDecode`.
 *  - Per-message verify failure → drop that message from the snapshot
 *    *and* from the batch's `MessageRow` writes (red-team C-8).
 *    Increments `skippedVerify`.
 *  - Substrate `(author, nonce)` conflict → catch, log, continue
 *    (red-team B-2). Increments `skippedConflict`.
 *
 * Multi-tag re-registration of the same `versionedHash` is handled
 * naturally: each `BlobBatchRegistered` event maps to a distinct
 * `BatchRow` keyed by `txHash` (red-team C-6).
 */

import { computeMessageHashForMessage, computeMessageId, FIELD_ELEMENTS_PER_BLOB } from 'bam-sdk';
import type { Address, BAMMessage, Bytes32 } from 'bam-sdk';
import type {
  BamStore,
  BatchMessageSnapshotEntry,
  BatchRow,
  MessageRow,
} from 'bam-store';

import { extractSegmentBytes } from '../blob-fetch/extract.js';
import {
  fetchBlob as defaultFetchBlob,
  type BlobSourceLogger,
} from '../blob-fetch/multi-source.js';
import { decode as defaultDecode, type DecodeOptions } from '../decode/dispatch.js';
import type { ReadContractClient } from '../decode/on-chain-decoder.js';
import {
  verifyMessage as defaultVerifyMessage,
  type VerifyMessageOptions,
} from '../verify/dispatch.js';
import type {
  OnChainVerifyEvent,
  VerifyReadContractClient,
} from '../verify/on-chain-registry.js';
import type { BlobBatchRegisteredEvent } from '../discovery/log-scan.js';
import { validateSegmentRange } from '../discovery/validate-range.js';
import type { ReaderCounters, ReaderEvent } from '../types.js';
import type { FetchLike } from '../blob-fetch/beacon.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

export interface ProcessBatchOptions {
  event: BlobBatchRegisteredEvent;
  parentBeaconBlockRoot: Bytes32 | null;
  /** L1 block timestamp (seconds) for `BatchRow.l1IncludedAtUnixSec`. */
  l1IncludedAtUnixSec: number | null;
  store: BamStore;
  sources: { beaconUrl?: string; blobscanUrl?: string };
  chainId: number;
  decodePublicClient?: ReadContractClient;
  verifyPublicClient?: VerifyReadContractClient;
  ethCallGasCap: bigint;
  ethCallTimeoutMs: number;
  fetchImpl?: FetchLike;
  /** Test injection — defaults to the real multi-source fetch. */
  fetchBlob?: typeof defaultFetchBlob;
  /** Test injection — defaults to the real decode dispatch. */
  decode?: (opts: DecodeOptions) => Promise<{
    messages: BAMMessage[];
    signatures: Uint8Array[];
  }>;
  /** Test injection — defaults to the real per-message verify dispatch. */
  verifyMessage?: (opts: VerifyMessageOptions) => Promise<boolean>;
  /** Counters mutated in place. */
  counters: ReaderCounters;
  logger?: (event: ReaderEvent) => void;
  now?: () => number;
}

export interface ProcessBatchResult {
  /** Tx index for cursor accounting (the live-tail loop tracks max per block). */
  txIndex: number;
  blockNumber: number;
  outcome: 'decoded' | 'unreachable' | 'decode_failed' | 'range_rejected';
  messagesWritten: number;
}

function isZeroAddress(addr: Address): boolean {
  return addr.toLowerCase() === ZERO_ADDRESS;
}

function isConflictError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes('different messageHash at the same (author, nonce)');
}

function buildBlobSourceLogger(
  log: ((event: ReaderEvent) => void) | undefined
): BlobSourceLogger | undefined {
  if (!log) return undefined;
  return (e) => {
    if (e.kind === 'source_lied') {
      log({ kind: 'blob_source_lied', versionedHash: e.versionedHash, source: e.source });
    }
    // The "all_sources_lied" event maps to a `blob_unreachable` log
    // with classification deferred to the caller (T016 retention check).
  };
}

function buildVerifyLogger(
  log: ((event: ReaderEvent) => void) | undefined,
  txHash: Bytes32,
  messageHash: Bytes32
): ((event: OnChainVerifyEvent) => void) | undefined {
  if (!log) return undefined;
  return (e) => {
    log({
      kind: 'message_verify_skipped',
      txHash,
      messageHash,
      cause: e.cause === 'gas_cap' ? 'gas_cap' : e.cause === 'timeout' ? 'timeout' : 'revert',
    });
  };
}

/**
 * Process one `BlobBatchRegistered` event end-to-end. Always returns
 * a result describing the outcome; throws only if the supplied
 * `bam-store` transaction itself fails (caller treats that as a halt).
 */
export async function processBatch(
  opts: ProcessBatchOptions
): Promise<ProcessBatchResult> {
  const log = opts.logger;
  const fetch = opts.fetchBlob ?? defaultFetchBlob;
  const decode = opts.decode ?? defaultDecode;
  const verify = opts.verifyMessage ?? defaultVerifyMessage;

  log?.({
    kind: 'batch_observed',
    txHash: opts.event.txHash,
    blockNumber: opts.event.blockNumber,
    contentTag: opts.event.contentTag,
  });

  // Range-validation chokepoint (006-blob-packing-multi-tag, C-2).
  // Reject malformed `(startFE, endFE)` from hostile or buggy submitters
  // *before* any byte slice or store write. log + skip; no row written;
  // no throw past this point. Events that don't carry an explicit range
  // are treated as full-blob `[0, 4096)` (the pre-feature wire shape and
  // the discovery-layer default).
  const startFE = opts.event.startFE ?? 0;
  const endFE = opts.event.endFE ?? FIELD_ELEMENTS_PER_BLOB;
  const rangeCheck = validateSegmentRange(startFE, endFE);
  if (!rangeCheck.ok) {
    log?.({
      kind: 'range_rejected',
      txHash: opts.event.txHash,
      versionedHash: opts.event.versionedHash,
      startFE,
      endFE,
      reason: rangeCheck.reason,
    });
    opts.counters.skippedRange += 1;
    return {
      txIndex: opts.event.txIndex,
      blockNumber: opts.event.blockNumber,
      outcome: 'range_rejected',
      messagesWritten: 0,
    };
  }

  const baseBatch: BatchRow = {
    txHash: opts.event.txHash,
    chainId: opts.chainId,
    contentTag: opts.event.contentTag,
    blobVersionedHash: opts.event.versionedHash,
    batchContentHash: opts.event.versionedHash, // ERC-8180: blob batch ⇒ versionedHash.
    blockNumber: opts.event.blockNumber,
    txIndex: opts.event.txIndex,
    status: 'confirmed',
    replacedByTxHash: null,
    submittedAt: null,
    invalidatedAt: null,
    submitter: opts.event.submitter,
    l1IncludedAtUnixSec: opts.l1IncludedAtUnixSec,
    messageSnapshot: [],
  };

  // 1. Fetch blob bytes from multi-source orchestrator.
  let blobBytes: Uint8Array | null = null;
  try {
    blobBytes = await fetch({
      versionedHash: opts.event.versionedHash,
      parentBeaconBlockRoot: opts.parentBeaconBlockRoot,
      sources: opts.sources,
      fetchImpl: opts.fetchImpl,
      logger: buildBlobSourceLogger(log),
    });
  } catch (err) {
    // A non-mismatch error from a fetch source (network failure) bubbles
    // up; the loop treats it as transient blob_unreachable.
    blobBytes = null;
    log?.({
      kind: 'blob_unreachable',
      txHash: opts.event.txHash,
      versionedHash: opts.event.versionedHash,
      classification: 'transient',
    });
    void err;
  }

  if (blobBytes === null) {
    log?.({
      kind: 'blob_unreachable',
      txHash: opts.event.txHash,
      versionedHash: opts.event.versionedHash,
      classification: 'transient', // refined by retention classifier in T016
    });
    opts.counters.undecodable += 1;
    await opts.store.withTxn(async (txn) => {
      await txn.upsertBatch(baseBatch);
    });
    return {
      txIndex: opts.event.txIndex,
      blockNumber: opts.event.blockNumber,
      outcome: 'unreachable',
      messagesWritten: 0,
    };
  }

  // 2. Decode (dispatch by event.decoder).
  // Range-aware slice: take only `[startFE * 31, endFE * 31)` of the
  // unpadded bytes; for events without an explicit range the chokepoint
  // already defaulted to the full-blob `[0, 4096)`.
  const usableBytes = extractSegmentBytes(blobBytes, startFE, endFE);
  let messages: BAMMessage[];
  let signatures: Uint8Array[];
  try {
    const decoded = await decode({
      decoderAddress: opts.event.decoder,
      usableBytes,
      publicClient: isZeroAddress(opts.event.decoder) ? undefined : opts.decodePublicClient,
      gasCap: opts.ethCallGasCap,
      timeoutMs: opts.ethCallTimeoutMs,
    });
    messages = decoded.messages;
    signatures = decoded.signatures;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log?.({ kind: 'batch_decode_failed', txHash: opts.event.txHash, error: detail });
    opts.counters.skippedDecode += 1;
    await opts.store.withTxn(async (txn) => {
      await txn.upsertBatch(baseBatch);
    });
    return {
      txIndex: opts.event.txIndex,
      blockNumber: opts.event.blockNumber,
      outcome: 'decode_failed',
      messagesWritten: 0,
    };
  }

  // 3. Per-message verify dispatch.
  type VerifiedEntry = {
    message: BAMMessage;
    signature: Uint8Array;
    indexWithinBatch: number;
    messageHash: Bytes32;
  };
  const verified: VerifiedEntry[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const sig = signatures[i];
    const messageHash = computeMessageHashForMessage(m);
    const ok = await verify({
      registryAddress: opts.event.signatureRegistry,
      message: m,
      signatureBytes: sig,
      chainId: opts.chainId,
      publicClient: isZeroAddress(opts.event.signatureRegistry)
        ? undefined
        : opts.verifyPublicClient,
      gasCap: opts.ethCallGasCap,
      timeoutMs: opts.ethCallTimeoutMs,
      logger: buildVerifyLogger(log, opts.event.txHash, messageHash),
    });
    if (!ok) {
      // Map zero-address (SDK) verify failures — which don't go through
      // the on-chain logger — into the structured log. Non-zero-registry
      // failures already logged via verifyLogger inside dispatch.
      if (isZeroAddress(opts.event.signatureRegistry)) {
        log?.({
          kind: 'message_verify_skipped',
          txHash: opts.event.txHash,
          messageHash,
          cause: 'invalid',
        });
      }
      opts.counters.skippedVerify += 1;
      continue;
    }
    log?.({
      kind: 'message_verified',
      txHash: opts.event.txHash,
      messageHash,
    });
    verified.push({ message: m, signature: sig, indexWithinBatch: i, messageHash });
  }

  // 4. Snapshot is over verified messages only (red-team C-8). Their
  //    `messageIndexWithinBatch` is the position in the *original*
  //    decoded list — that's the canonical batch ordering, regardless
  //    of which messages dropped on verify.
  const batchContentHash = opts.event.versionedHash;
  const snapshot: BatchMessageSnapshotEntry[] = verified.map((v) => ({
    author: v.message.sender,
    nonce: v.message.nonce,
    messageId: computeMessageId(v.message.sender, v.message.nonce, batchContentHash),
    messageHash: v.messageHash,
    messageIndexWithinBatch: v.indexWithinBatch,
  }));

  // The Reader doesn't know the Poster-side ingest time; `submittedAt`
  // stays null and the substrate's COALESCE preserves any value the
  // Poster wrote first. `submitter` and `l1IncludedAtUnixSec`, by
  // contrast, are Reader-derived (event topic + block timestamp) and
  // are populated on `baseBatch`.
  const messagesWritten = await opts.store.withTxn(async (txn) => {
    await txn.upsertBatch({
      ...baseBatch,
      messageSnapshot: snapshot,
    });
    let written = 0;
    for (const v of verified) {
      const messageId = computeMessageId(
        v.message.sender,
        v.message.nonce,
        batchContentHash
      );
      const row: MessageRow = {
        messageId,
        author: v.message.sender,
        nonce: v.message.nonce,
        contentTag: opts.event.contentTag,
        contents: new Uint8Array(v.message.contents),
        signature: new Uint8Array(v.signature),
        messageHash: v.messageHash,
        status: 'confirmed',
        batchRef: opts.event.txHash,
        ingestedAt: null,
        ingestSeq: null,
        blockNumber: opts.event.blockNumber,
        txIndex: opts.event.txIndex,
        messageIndexWithinBatch: v.indexWithinBatch,
      };
      try {
        await txn.upsertObserved(row);
        written += 1;
      } catch (err) {
        if (isConflictError(err)) {
          opts.counters.skippedConflict += 1;
          log?.({
            kind: 'message_conflict',
            txHash: opts.event.txHash,
            messageHash: v.messageHash,
            author: v.message.sender,
            nonce: v.message.nonce,
          });
          continue;
        }
        throw err;
      }
    }
    return written;
  });

  opts.counters.decoded += messagesWritten;
  log?.({
    kind: 'batch_decoded',
    txHash: opts.event.txHash,
    messageCount: messagesWritten,
  });
  return {
    txIndex: opts.event.txIndex,
    blockNumber: opts.event.blockNumber,
    outcome: 'decoded',
    messagesWritten,
  };
}

/** Side-effect-free counters factory — used by callers and tests. */
export function emptyCounters(): ReaderCounters {
  return {
    decoded: 0,
    skippedDecode: 0,
    skippedVerify: 0,
    skippedConflict: 0,
    undecodable: 0,
    skippedRange: 0,
  };
}
