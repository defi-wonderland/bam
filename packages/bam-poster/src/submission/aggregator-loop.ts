/**
 * Aggregator-driven submission loop (T022).
 *
 * Top-level scheduler: each tick snapshots pending pools across every
 * allowlisted tag, runs each tag's `BatchPolicy.select` per the
 * existing latency contract, hands the result to the cross-tag
 * aggregator (T019) for oldest-first arbitration + plan, and submits
 * a single packed `registerBlobBatches` transaction (T021). On
 * confirmation, writes one `BatchRow` per included tag and updates
 * each per-tag selection's messages to `confirmed` — all in one
 * `withTxn` so a packed-tx confirmation is observably atomic.
 *
 * Permanent failure halts the aggregator entirely (and thus every
 * allowlisted tag's submission). A producer-side bug — self-check
 * mismatch, plan invariant violation, etc. — cannot be unstuck by
 * retrying, so the only correct behavior is to halt and surface the
 * `permanentlyStopped` flag for operator inspection.
 */

import { computeMessageId, type BAMMessage, type Bytes32 } from 'bam-sdk';
import type { BatchMessageSnapshotEntry } from 'bam-store';

import type {
  BatchPolicy,
  DecodedMessage,
  HealthState,
  PoolView,
  PosterLogger,
  BamStore,
  StoreTxnPendingRow,
} from '../types.js';
import { BackoffState } from './backoff.js';
import type { BackoffConfig } from '../types.js';
import {
  createAggregator,
  type Aggregator,
  type PackingLossSnapshot,
} from './aggregator.js';
import type { BuildAndSubmitMulti, PackedSubmitOutcome } from './types.js';

const NOOP_LOGGER: PosterLogger = () => undefined;

export interface AggregatorLoopOptions {
  tags: readonly Bytes32[];
  chainId: number;
  store: BamStore;
  policy: BatchPolicy;
  blobCapacityBytes: number;
  buildAndSubmitMulti: BuildAndSubmitMulti;
  backoff: BackoffConfig;
  now: () => Date;
  reorgWindowBlocks: number;
  /**
   * Maximum number of per-tag entries to pack into one transaction.
   * Default `8`; setting to `1` short-circuits to single-tag behavior
   * (the disabled-aggregation shape).
   */
  maxTagsPerPack?: number;
  logger?: PosterLogger;
  /**
   * Capacity caps. Default to the SDK's blob constants. Tests inject
   * narrower values to exercise overflow paths without producing
   * 4096-FE fixtures.
   */
  capacityFEs?: number;
  capacityBytes?: number;
  /**
   * Test-only encoder injection. Defaults to the SDK's `encodeBatch`.
   * A test stubbing this can produce deterministic byte counts to
   * pin the planner's FE math without depending on encoded-batch
   * overhead arithmetic.
   */
  encodeBatch?: (msgs: BAMMessage[], signatures: Uint8Array[]) => { data: Uint8Array };
}

export class AggregatorLoop {
  private readonly aggregator: Aggregator;
  private readonly backoff: BackoffState;
  private readonly log: PosterLogger;
  private permanentlyStopped = false;
  private lastPackedTxHash: Bytes32 | null = null;
  private lastPackedTagCount = 0;

  constructor(private readonly opts: AggregatorLoopOptions) {
    this.aggregator = createAggregator({
      policy: opts.policy,
      tags: opts.tags,
      maxTagsPerPack: opts.maxTagsPerPack ?? 8,
      blobCapacityBytes: opts.blobCapacityBytes,
      capacityFEs: opts.capacityFEs,
      capacityBytes: opts.capacityBytes,
      now: opts.now,
      encodeBatch: opts.encodeBatch,
    });
    this.backoff = new BackoffState(opts.backoff);
    this.log = opts.logger ?? NOOP_LOGGER;
  }

  healthState(): HealthState {
    if (this.permanentlyStopped) return 'unhealthy';
    return this.backoff.healthFromAttempts();
  }

  isPermanentlyStopped(): boolean {
    return this.permanentlyStopped;
  }

  nextDelayMs(): number {
    return this.backoff.nextDelayMs();
  }

  attempts(): number {
    return this.backoff.attempts();
  }

  packingLossSnapshot(): PackingLossSnapshot[] {
    return this.aggregator.packingLossSnapshot();
  }

  lastPackedSnapshot(): { txHash: Bytes32 | null; tagCount: number } {
    return {
      txHash: this.lastPackedTxHash,
      tagCount: this.lastPackedTagCount,
    };
  }

  async tick(): Promise<'idle' | 'success' | 'retry' | 'permanent'> {
    if (this.permanentlyStopped) return 'permanent';

    // 1. Snapshot pending pools across every allowlisted tag in one
    //    read txn.
    const poolMap = await this.opts.store.withTxn(async (txn) => {
      const map = new Map<Bytes32, DecodedMessage[]>();
      for (const tag of this.opts.tags) {
        const rows = await txn.listPendingByTag(tag);
        map.set(tag, rows.map(pendingRowToDecoded));
      }
      return map;
    });
    const pool: PoolView = { list: (tag: Bytes32) => poolMap.get(tag) ?? [] };

    // 2. Aggregator runs per-tag select + plan + streak update.
    const tickResult = this.aggregator.tick({
      pool,
      tags: this.opts.tags,
      now: this.opts.now(),
    });
    if (tickResult.pack === null || tickResult.pack.plan.included.length === 0) {
      return 'idle';
    }

    // 3. Submit one type-3 tx via registerBlobBatches.
    const outcome: PackedSubmitOutcome = await this.opts.buildAndSubmitMulti({
      pack: tickResult.pack,
    });

    if (outcome.kind === 'included') {
      const submittedAt = this.opts.now().getTime();
      const batchContentHash = outcome.blobVersionedHash;
      const reorgWindow = this.opts.reorgWindowBlocks;

      await this.opts.store.withTxn(async (txn) => {
        for (const entry of outcome.entries) {
          const snapshot: BatchMessageSnapshotEntry[] = entry.messages.map((m, i) => ({
            author: m.sender,
            nonce: m.nonce,
            messageId: computeMessageId(m.sender, m.nonce, batchContentHash),
            messageHash: m.messageHash,
            messageIndexWithinBatch: i,
          }));

          await txn.upsertBatch({
            txHash: outcome.txHash,
            chainId: this.opts.chainId,
            contentTag: entry.contentTag,
            blobVersionedHash: outcome.blobVersionedHash,
            batchContentHash,
            blockNumber: outcome.blockNumber,
            txIndex: outcome.txIndex,
            status: 'confirmed',
            replacedByTxHash: null,
            submittedAt,
            invalidatedAt: null,
            submitter: outcome.submitter,
            // Reader fills `l1IncludedAtUnixSec` from the L1 block
            // timestamp (Poster receipt does not carry it).
            l1IncludedAtUnixSec: null,
            messageSnapshot: snapshot,
          });

          for (let i = 0; i < entry.messages.length; i++) {
            const m = entry.messages[i]!;
            const row = await txn.getByAuthorNonce(m.sender, m.nonce);
            if (row === null) continue;
            const messageId = computeMessageId(
              m.sender,
              m.nonce,
              batchContentHash
            );
            await txn.upsertObserved({
              messageId,
              author: m.sender,
              nonce: m.nonce,
              contentTag: entry.contentTag,
              contents: new Uint8Array(m.contents),
              signature: new Uint8Array(m.signature),
              messageHash: m.messageHash,
              status: 'confirmed',
              batchRef: outcome.txHash,
              chainId: this.opts.chainId,
              ingestedAt: row.ingestedAt,
              ingestSeq: row.ingestSeq,
              blockNumber: outcome.blockNumber,
              txIndex: outcome.txIndex,
              messageIndexWithinBatch: i,
            });
          }

          // Chain any prior reorged batch (scoped per included tag)
          // whose snapshot overlaps with this submission, marking it
          // `replacedByTxHash`. Overlap is computed against the
          // reorged batch's frozen snapshot, not against current
          // `messages.batch_ref` — which has been cleared by the
          // re-enqueue path.
          const includedHashSet = new Set(
            snapshot.map((e) => e.messageHash.toLowerCase())
          );
          const windowStart = BigInt(
            Math.max(0, outcome.blockNumber - reorgWindow)
          );
          const reorged = await txn.listBatches({
            chainId: this.opts.chainId,
            contentTag: entry.contentTag,
            status: 'reorged',
            sinceBlock: windowStart,
          });
          for (const b of reorged) {
            if (b.replacedByTxHash !== null) continue;
            const overlaps = b.messageSnapshot.some((m) =>
              includedHashSet.has(m.messageHash.toLowerCase())
            );
            if (overlaps) {
              await txn.updateBatchStatus(
                b.chainId,
                b.txHash,
                b.contentTag,
                'reorged',
                { replacedByTxHash: outcome.txHash }
              );
            }
          }
        }
      });

      this.lastPackedTxHash = outcome.txHash;
      this.lastPackedTagCount = outcome.entries.length;
      this.backoff.recordSuccess();
      this.log(
        'info',
        `aggregator submitted ${outcome.entries.length} tag(s) → ` +
          `tx ${outcome.txHash} (block ${outcome.blockNumber}, ` +
          `versionedHash ${outcome.blobVersionedHash})`
      );
      return 'success';
    }

    if (outcome.kind === 'retryable') {
      this.backoff.recordFailure();
      this.log(
        'warn',
        `aggregator retryable failure (${outcome.detail}) ` +
          `attempt ${this.backoff.attempts()}, next in ${this.backoff.nextDelayMs()} ms`
      );
      return 'retry';
    }

    // permanent — halts the aggregator (and thus every tag's submission).
    this.backoff.recordFailure();
    this.log(
      'error',
      `aggregator PERMANENT failure (${outcome.detail}) — operator must intervene`
    );
    this.permanentlyStopped = true;
    return 'permanent';
  }
}

function pendingRowToDecoded(row: StoreTxnPendingRow): DecodedMessage {
  return {
    sender: row.sender,
    nonce: row.nonce,
    contents: row.contents,
    contentTag: row.contentTag,
    signature: row.signature,
    messageHash: row.messageHash,
    ingestedAt: row.ingestedAt,
  };
}
