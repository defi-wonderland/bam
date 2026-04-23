import type { Bytes32 } from 'bam-sdk';

import type {
  BatchPolicy,
  DecodedMessage,
  HealthState,
  MessageSnapshot,
  PoolView,
  PosterStore,
  StoreTxnPendingRow,
} from '../types.js';
import { BackoffState } from './backoff.js';
import type { BackoffConfig } from '../types.js';
import type { BuildAndSubmit } from './types.js';

export interface SubmissionLoopOptions {
  tag: Bytes32;
  store: PosterStore;
  policy: BatchPolicy;
  blobCapacityBytes: number;
  buildAndSubmit: BuildAndSubmit;
  backoff: BackoffConfig;
  now: () => Date;
  /**
   * Reorg-tolerance window, in blocks. Used to bound the
   * `replacedByTxHash` link walk (FU-2 / R2) — any `reorged` row
   * older than `includedBlockNumber - reorgWindowBlocks` is past the
   * window where a reorg could have affected it and needn't be
   * considered.
   */
  reorgWindowBlocks: number;
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
  private permanentlyStopped = false;

  constructor(private readonly opts: SubmissionLoopOptions) {
    this.backoff = new BackoffState(opts.backoff);
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
      // 4. Snapshot payloads + insert submitted row + prune pending +
      //    link any prior `reorged` rows whose messages we just
      //    resubmitted — all in ONE `withTxn` (FU-3). The snapshot is
      //    retained on the submitted row so the reorg watcher can
      //    re-enqueue without depending on the pending pool surviving
      //    past inclusion.
      const includedMessageIds = picked.map((m) => m.messageId);
      const submittedAt = this.opts.now().getTime();
      await this.opts.store.withTxn(async (txn) => {
        // Snapshot the full pending rows for the messages we picked.
        // If any have already been pruned (shouldn't happen inside the
        // same txn, but defensively), skip — the submission still lands,
        // we just can't recover that payload on reorg.
        const snaps: MessageSnapshot[] = [];
        for (const m of picked) {
          const row = await txn.getPendingByMessageId(m.messageId);
          if (row === null) continue;
          snaps.push({
            messageId: row.messageId,
            author: row.author,
            nonce: row.nonce,
            timestamp: row.timestamp,
            content: new TextDecoder().decode(row.content),
            signature: new Uint8Array(row.signature),
            originalIngestSeq: row.ingestSeq,
          });
        }

        await txn.insertSubmitted({
          txHash: outcome.txHash,
          contentTag: this.opts.tag,
          blobVersionedHash: outcome.blobVersionedHash,
          blockNumber: outcome.blockNumber,
          status: 'included',
          replacedByTxHash: null,
          submittedAt,
          messageIds: includedMessageIds,
          messages: snaps,
        });
        await txn.deletePending(includedMessageIds);

        // FU-2: any prior `reorged` row for this tag whose messageIds
        // overlap with the batch we just submitted now has its
        // `replacedByTxHash` link. R2: bound the walk to the reorg
        // window so this stays O(window) on a Poster that's been
        // running for months.
        const includedSet = new Set(includedMessageIds.map((id) => id.toLowerCase()));
        const windowStart = BigInt(
          Math.max(0, outcome.blockNumber - this.opts.reorgWindowBlocks)
        );
        const recent = await txn.listSubmitted({
          contentTag: this.opts.tag,
          sinceBlock: windowStart,
        });
        for (const entry of recent) {
          if (entry.status !== 'reorged') continue;
          if (entry.replacedByTxHash !== null) continue; // already chained
          const overlaps = entry.messageIds.some((id) =>
            includedSet.has(id.toLowerCase())
          );
          if (overlaps) {
            await txn.updateSubmittedStatus(
              entry.txHash,
              'reorged',
              outcome.txHash,
              entry.blockNumber
            );
          }
        }
      });
      this.backoff.recordSuccess();
      process.stdout.write(
        `[bam-poster] tag ${this.opts.tag} submitted ` +
          `${includedMessageIds.length} message(s) → tx ${outcome.txHash} ` +
          `(block ${outcome.blockNumber}, versionedHash ${outcome.blobVersionedHash})\n`
      );
      return 'success';
    }

    if (outcome.kind === 'retryable') {
      this.backoff.recordFailure();
      process.stderr.write(
        `[bam-poster] tag ${this.opts.tag} retryable failure ` +
          `(attempt ${this.backoff.attempts()}, next in ${this.backoff.nextDelayMs()} ms)\n`
      );
      return 'retry';
    }

    // permanent — stop this tag's worker. Operator must intervene.
    this.backoff.recordFailure();
    process.stderr.write(
      `[bam-poster] tag ${this.opts.tag} PERMANENT failure — worker stopped. ` +
        `Operator must intervene.\n`
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
    author: row.author,
    timestamp: row.timestamp,
    nonce: row.nonce,
    content: new TextDecoder().decode(row.content),
    contentTag: row.contentTag,
    signature: row.signature,
    messageId: row.messageId,
    raw: row.content,
    ingestedAt: row.ingestedAt,
  };
}
