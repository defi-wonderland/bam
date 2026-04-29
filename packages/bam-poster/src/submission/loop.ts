import { computeMessageId, type Bytes32 } from 'bam-sdk';
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
import type { BuildAndSubmit } from './types.js';

const NOOP_LOGGER: PosterLogger = () => undefined;

export interface SubmissionLoopOptions {
  tag: Bytes32;
  /** Chain id the Poster is submitting to. Stored on written batch rows. */
  chainId: number;
  store: BamStore;
  policy: BatchPolicy;
  blobCapacityBytes: number;
  buildAndSubmit: BuildAndSubmit;
  backoff: BackoffConfig;
  now: () => Date;
  /**
   * Reorg-tolerance window, in blocks. Used to bound the
   * `replacedByTxHash` link walk — any `reorged` row older than
   * `includedBlockNumber - reorgWindowBlocks` is past the window where
   * a reorg could have affected it and needn't be considered.
   */
  reorgWindowBlocks: number;
  /**
   * Optional logger for tick outcomes. Defaults to a no-op so tests
   * stay quiet; the factory's default wires through stdout/stderr.
   */
  logger?: PosterLogger;
}

/**
 * Per-tag submission worker. Runs a tick:
 *
 *   1. Snapshot pending pool for the tag (under txn).
 *   2. `BatchPolicy.select(...)` — returns null → no-op.
 *   3. `buildAndSubmit(tag, msgs)` — encode + blob + commit + tx.
 *   4. On include: record submitted batch, prune pending.
 *   5. On retryable fail: increment backoff, surface health state.
 *   6. On permanent fail: same but we do not keep retrying — emit an
 *      `unhealthy` signal and hold. The tag stays pending for operator
 *      inspection.
 *
 * The loop itself is a function you call repeatedly; scheduling (timers,
 * worker processes, manual flush) is the caller's responsibility.
 */
export class SubmissionLoop {
  private readonly backoff: BackoffState;
  private readonly log: PosterLogger;
  private permanentlyStopped = false;

  constructor(private readonly opts: SubmissionLoopOptions) {
    this.backoff = new BackoffState(opts.backoff);
    this.log = opts.logger ?? NOOP_LOGGER;
  }

  healthState(): HealthState {
    if (this.permanentlyStopped) return 'unhealthy';
    return this.backoff.healthFromAttempts();
  }

  nextDelayMs(): number {
    return this.backoff.nextDelayMs();
  }

  attempts(): number {
    return this.backoff.attempts();
  }

  /**
   * Run one submission tick. Returns the outcome so callers (tests,
   * scheduler) can decide when to wake again.
   */
  async tick(): Promise<'idle' | 'success' | 'retry' | 'permanent'> {
    if (this.permanentlyStopped) return 'permanent';

    // 1+2: snapshot + policy.select run without the txn lock so the
    // long-running submission doesn't starve ingest.
    const picked = await this.selectBatch();
    if (picked === null || picked.length === 0) return 'idle';

    // 3. Submit.
    const outcome = await this.opts.buildAndSubmit({
      contentTag: this.opts.tag,
      messages: picked,
    });

    if (outcome.kind === 'included') {
      // 4. Snapshot payloads + insert confirmed batch + prune pending +
      //    link any prior `reorged` rows whose messages we just
      //    resubmitted — all in ONE `withTxn`. Each message gets its
      //    batch-scoped `messageId` computed from the blob-versioned
      //    hash (ERC-8180 messageId = keccak256(sender, nonce,
      //    batchContentHash)).
      const batchContentHash = outcome.blobVersionedHash;
      const submittedAt = this.opts.now().getTime();
      await this.opts.store.withTxn(async (txn) => {
        // The batch's `messageSnapshot` is built from `picked` directly —
        // every message that was submitted on-chain MUST appear in the
        // snapshot, regardless of whether the pending row has already
        // been transitioned out of `pending` by another writer in a
        // shared-DB scenario. If we built from getPendingByKey() we'd
        // silently drop entries whose row was already confirmed, leaving
        // listSubmittedBatches with a partial messages list and breaking
        // resubmission overlap detection.
        const snapshot: BatchMessageSnapshotEntry[] = picked.map((m, i) => ({
          author: m.sender,
          nonce: m.nonce,
          messageId: computeMessageId(m.sender, m.nonce, batchContentHash),
          messageHash: m.messageHash,
          messageIndexWithinBatch: i,
        }));

        // Batch row: tx is already included at a block by the time
        // buildAndSubmit returned 'included', so write status=confirmed.
        // The snapshot is the durable record of which messages were in
        // this batch — it survives subsequent reorg + re-enqueue.
        await txn.upsertBatch({
          txHash: outcome.txHash,
          chainId: this.opts.chainId,
          contentTag: this.opts.tag,
          blobVersionedHash: outcome.blobVersionedHash,
          batchContentHash,
          blockNumber: outcome.blockNumber,
          txIndex: outcome.txIndex,
          status: 'confirmed',
          replacedByTxHash: null,
          submittedAt,
          invalidatedAt: null,
          submitter: outcome.submitter,
          // The Reader's live-tail fills `l1IncludedAtUnixSec` from the
          // L1 block timestamp. The Poster's receipt does not carry it
          // and a separate `getBlock` per submit would double the RPC
          // count — let the Reader populate this column.
          l1IncludedAtUnixSec: null,
          messageSnapshot: snapshot,
        });

        // Pending → confirmed for every message we picked. Read each
        // row's current state via getByAuthorNonce (not getPendingByKey,
        // which filters to status='pending'); this keeps ingestedAt /
        // ingestSeq stable even when another writer has already moved
        // the row out of pending.
        for (let i = 0; i < picked.length; i++) {
          const m = picked[i];
          const row = await txn.getByAuthorNonce(m.sender, m.nonce);
          if (row === null) continue;
          const messageId = computeMessageId(m.sender, m.nonce, batchContentHash);
          await txn.upsertObserved({
            messageId,
            author: m.sender,
            nonce: m.nonce,
            contentTag: this.opts.tag,
            contents: new Uint8Array(m.contents),
            signature: new Uint8Array(m.signature),
            messageHash: m.messageHash,
            status: 'confirmed',
            batchRef: outcome.txHash,
            ingestedAt: row.ingestedAt,
            ingestSeq: row.ingestSeq,
            blockNumber: outcome.blockNumber,
            txIndex: outcome.txIndex,
            messageIndexWithinBatch: i,
          });
        }

        // Chain any prior reorged batch whose messages overlap with
        // this submission: mark it resubmitted (status=reorged with
        // replacedByTxHash set). Overlap is computed against the
        // reorged batch's frozen snapshot, not against current
        // `messages.batch_ref` — which has been cleared by re-enqueue.
        const includedHashSet = new Set(snapshot.map((e) => e.messageHash.toLowerCase()));
        const windowStart = BigInt(
          Math.max(0, outcome.blockNumber - this.opts.reorgWindowBlocks)
        );
        const reorged = await txn.listBatches({
          contentTag: this.opts.tag,
          status: 'reorged',
          sinceBlock: windowStart,
        });
        for (const b of reorged) {
          if (b.replacedByTxHash !== null) continue;
          const overlaps = b.messageSnapshot.some((e) =>
            includedHashSet.has(e.messageHash.toLowerCase())
          );
          if (overlaps) {
            await txn.updateBatchStatus(b.txHash, 'reorged', {
              replacedByTxHash: outcome.txHash,
            });
          }
        }
      });
      this.backoff.recordSuccess();
      this.log(
        'info',
        `tag ${this.opts.tag} submitted ${picked.length} message(s) → ` +
          `tx ${outcome.txHash} (block ${outcome.blockNumber}, ` +
          `versionedHash ${outcome.blobVersionedHash})`
      );
      return 'success';
    }

    if (outcome.kind === 'retryable') {
      this.backoff.recordFailure();
      this.log(
        'warn',
        `tag ${this.opts.tag} retryable failure ` +
          `(attempt ${this.backoff.attempts()}, next in ${this.backoff.nextDelayMs()} ms)`
      );
      return 'retry';
    }

    // permanent — stop this tag's worker. Operator must intervene.
    this.backoff.recordFailure();
    this.log(
      'error',
      `tag ${this.opts.tag} PERMANENT failure — worker stopped. Operator must intervene.`
    );
    this.permanentlyStopped = true;
    return 'permanent';
  }

  private async selectBatch(): Promise<DecodedMessage[] | null> {
    const msgs = await this.opts.store.withTxn(async (txn) => {
      const rows = await txn.listPendingByTag(this.opts.tag);
      return rows.map(pendingRowToDecoded);
    });
    const pool: PoolView = { list: () => msgs };
    const selected = this.opts.policy.select(
      this.opts.tag,
      pool,
      this.opts.blobCapacityBytes,
      this.opts.now()
    );
    return selected?.msgs ?? null;
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
