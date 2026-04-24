import { computeMessageId, type Bytes32 } from 'bam-sdk';

import type {
  BatchPolicy,
  DecodedMessage,
  HealthState,
  MessageSnapshot,
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
      // 4. Snapshot payloads + insert submitted row + prune pending +
      //    link any prior `reorged` rows whose messages we just
      //    resubmitted — all in ONE `withTxn`. Each message gets its
      //    batch-scoped `messageId` computed from the blob-versioned
      //    hash (ERC-8180 messageId = keccak256(sender, nonce,
      //    batchContentHash)).
      const batchContentHash = outcome.blobVersionedHash;
      const pickedKeys = picked.map((m) => ({ sender: m.sender, nonce: m.nonce }));
      const submittedAt = this.opts.now().getTime();
      await this.opts.store.withTxn(async (txn) => {
        const snaps: MessageSnapshot[] = [];
        for (const m of picked) {
          const row = await txn.getPendingByKey({ sender: m.sender, nonce: m.nonce });
          if (row === null) continue;
          const messageId = computeMessageId(row.sender, row.nonce, batchContentHash);
          snaps.push({
            sender: row.sender,
            nonce: row.nonce,
            contents: new Uint8Array(row.contents),
            signature: new Uint8Array(row.signature),
            messageHash: row.messageHash,
            messageId,
            originalIngestSeq: row.ingestSeq,
          });
        }

        await txn.insertSubmitted({
          txHash: outcome.txHash,
          contentTag: this.opts.tag,
          blobVersionedHash: outcome.blobVersionedHash,
          batchContentHash,
          blockNumber: outcome.blockNumber,
          status: 'included',
          replacedByTxHash: null,
          submittedAt,
          invalidatedAt: null,
          messages: snaps,
        });
        await txn.deletePending(pickedKeys);

        // Chain any prior `reorged` row whose messageHash set
        // overlaps with this submission: transition it to
        // `resubmitted` and link via `replacedByTxHash`.
        const includedHashSet = new Set(
          snaps.map((s) => s.messageHash.toLowerCase())
        );
        const windowStart = BigInt(
          Math.max(0, outcome.blockNumber - this.opts.reorgWindowBlocks)
        );
        const recent = await txn.listSubmitted({
          contentTag: this.opts.tag,
          sinceBlock: windowStart,
        });
        for (const entry of recent) {
          if (entry.status !== 'reorged') continue;
          if (entry.replacedByTxHash !== null) continue;
          const overlaps = entry.messages.some((m) =>
            includedHashSet.has(m.messageHash.toLowerCase())
          );
          if (overlaps) {
            await txn.updateSubmittedStatus(
              entry.txHash,
              'resubmitted',
              outcome.txHash,
              entry.blockNumber
            );
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
