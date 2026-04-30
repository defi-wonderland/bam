import type { Address, Bytes32 } from 'bam-sdk';

import type {
  BatchPolicy,
  Health,
  HealthState,
  MessageValidator,
  Pending,
  PendingQuery,
  Poster,
  PosterConfig,
  PosterLogger,
  BamStore,
  Status,
  SubmitHint,
  SubmitResult,
  SubmittedBatch,
  SubmittedBatchesQuery,
} from './types.js';
import { IngestPipeline } from './ingest/pipeline.js';
import { DEFAULT_RATE_LIMIT, RateLimiter } from './ingest/rate-limit.js';
import {
  DEFAULT_MAX_CONTENTS_SIZE_BYTES,
  DEFAULT_MAX_MESSAGE_SIZE_BYTES,
} from './ingest/size-bound.js';
import { createMemoryStore } from 'bam-store';
import { defaultBatchPolicy, DEFAULT_BLOB_CAPACITY_BYTES } from './policy/default.js';
import { AggregatorLoop } from './submission/aggregator-loop.js';
import type { BuildAndSubmitMulti } from './submission/types.js';
import { DEFAULT_BACKOFF } from './submission/backoff.js';
import {
  ReorgWatcher,
  clampReorgWindow,
  type BlockSource,
} from './submission/reorg-watcher.js';
import { WorkerTimer } from './submission/scheduler.js';
import { defaultEcdsaValidator } from './validator/default-ecdsa.js';
import {
  reconcileSchemaVersion,
  reconcileStartup,
  type ReconcileRpcClient,
} from './startup/reconcile.js';
import { listPending } from './surfaces/pending.js';
import { listSubmittedBatches } from './surfaces/submitted.js';
import { readStatus, type StatusRpcReader } from './surfaces/status.js';
import { readHealth } from './surfaces/health.js';
import { canonicalTag } from './util/canonical.js';

/**
 * Process-local registry. `createPoster` rejects two instances with
 * the same signer address in the same process. Cross-process
 * coordination is a non-goal.
 */
const signerRegistry = new Set<Address>();

export interface PosterFactoryExtras {
  /**
   * Multi-tag (packed) submission path — the only on-chain submitter
   * path after 006-blob-packing-multi-tag. Calls
   * `registerBlobBatches`; single-tag rounds emit a one-element
   * array. Not wired by `createPoster` itself because the real
   * implementation pulls the KZG trusted setup at runtime
   * (`buildAndSubmitWithViem` in `src/submission/build-and-submit.ts`).
   */
  buildAndSubmitMulti: BuildAndSubmitMulti;
  /** Chain-ID + bytecode reconciler. */
  rpc: ReconcileRpcClient & StatusRpcReader & BlockSource;
}

/**
 * Internal test hooks. Not part of the documented public surface,
 * but typed so tests don't resort to `as any`. Production callers
 * use `Poster`; deterministic-stepping unit tests cast to
 * `InternalPoster` and drive ticks directly without calling
 * `start()` (which would spawn autonomous workers).
 */
export interface InternalPoster extends Poster {
  /** Drive one cross-tag aggregator tick. */
  _tickAggregator(): Promise<'idle' | 'success' | 'retry' | 'permanent'>;
  _tickReorgWatcher(): Promise<{ reorgedCount: number; keptCount: number }>;
  _started(): boolean;
  _stopped(): boolean;
}

const DEFAULT_IDLE_POLL_MS = 1_000;
const DEFAULT_REORG_POLL_MS = 12_000;
/**
 * Operator-visible packing-loss-streak warning threshold (T023). The
 * `/health` surface flags any tag whose `packingLossStreak >=` this
 * value as `warn: true`. Detection-only — no behavior change.
 */
export const DEFAULT_PACKING_LOSS_STREAK_WARN_THRESHOLD = 10;

/**
 * Default logger — info/warn to stdout, error to stderr, same
 * `[bam-poster]` prefix the old inline writes used. Consumers can
 * replace via `PosterConfig.logger` (qodo review — unconfigurable
 * stdout logging).
 */
const defaultLogger: PosterLogger = (level, message) => {
  const line = `[bam-poster] ${message}\n`;
  if (level === 'error') {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
};

/**
 * Constructs a Poster wired with every piece it needs. Startup
 * reconciliation (chain-ID + contract code) runs *before* any
 * submission loop is created; a mismatch throws synchronously.
 *
 * `start()` spawns the cross-tag aggregator worker + the reorg-
 * watcher worker; `stop()` cancels them and drains in-flight ticks
 * before closing the store.
 */
export async function createPoster(
  config: PosterConfig,
  extras: PosterFactoryExtras
): Promise<Poster> {
  const address = config.signer.account().address;
  if (signerRegistry.has(address)) {
    throw new Error(
      `createPoster: a Poster instance is already configured with signer ${address} in this process`
    );
  }
  signerRegistry.add(address);

  // Clean the registry entry on ANY mid-construction throw, not just
  // reconcileStartup's. Any later step can also fail and a leaked
  // entry would spuriously reject the next createPoster with this
  // signer.
  try {
    await reconcileStartup(extras.rpc, {
      chainId: config.chainId,
      bamCoreAddress: config.bamCoreAddress,
    });

    const store: BamStore = config.store ?? (await createMemoryStore());
    await reconcileSchemaVersion(store);
    const validator: MessageValidator = config.validator ?? defaultEcdsaValidator(config.chainId);
    const batchPolicy: BatchPolicy = config.batchPolicy ?? defaultBatchPolicy();
    const maxMessageSize = config.maxMessageSizeBytes ?? DEFAULT_MAX_MESSAGE_SIZE_BYTES;
    const maxContentsSize = config.maxContentsSizeBytes ?? DEFAULT_MAX_CONTENTS_SIZE_BYTES;
    const blobCapacity = config.blobCapacityBytes ?? DEFAULT_BLOB_CAPACITY_BYTES;
    const reorgWindow = clampReorgWindow(config.reorgWindowBlocks ?? 32);
    const now = config.now ?? (() => new Date());
    const rateLimit = config.rateLimit ?? DEFAULT_RATE_LIMIT;
    const backoff = config.backoff ?? DEFAULT_BACKOFF;
    const idlePollMs = config.idlePollMs ?? DEFAULT_IDLE_POLL_MS;
    const reorgPollMs = config.reorgPollMs ?? DEFAULT_REORG_POLL_MS;
    const logger: PosterLogger = config.logger ?? defaultLogger;
    const packingLossWarnThreshold =
      config.packingLossStreakWarnThreshold ?? DEFAULT_PACKING_LOSS_STREAK_WARN_THRESHOLD;

    // Canonicalize the configured allowlist once; downstream maps,
    // store queries, and comparisons all operate on this single
    // representation. `parseEnv` also lowercases, but callers
    // constructing `PosterConfig` directly (tests, embeds) bypass that.
    const allowlistedTags: Bytes32[] = config.allowlistedTags.map((t) =>
      canonicalTag(t)
    );

    const rateLimiter = new RateLimiter(rateLimit, () => now().getTime());
    const pipeline = new IngestPipeline({
      store,
      validator,
      rateLimiter,
      allowlistedTags,
      maxMessageSizeBytes: maxMessageSize,
      maxContentsSizeBytes: maxContentsSize,
      now,
    });

    const reorgWatcher = new ReorgWatcher({
      store,
      blockSource: extras.rpc,
      chainId: config.chainId,
      reorgWindowBlocks: reorgWindow,
      now,
    });

    // Top-level cross-tag aggregator. After 006-blob-packing-multi-tag
    // this is the only submission path; single-tag rounds emit a
    // one-element `registerBlobBatches` array.
    const aggregatorLoop = new AggregatorLoop({
      tags: allowlistedTags,
      chainId: config.chainId,
      store,
      policy: batchPolicy,
      blobCapacityBytes: blobCapacity,
      buildAndSubmitMulti: extras.buildAndSubmitMulti,
      backoff,
      now,
      reorgWindowBlocks: reorgWindow,
      maxTagsPerPack: config.maxTagsPerPack,
      capacityFEs: config.aggregatorCapacityFEs,
      capacityBytes: config.aggregatorCapacityBytes,
      encodeBatch: config.aggregatorEncodeBatch,
      logger,
    });

    const reorgWorker = new WorkerTimer(async () => {
      await reorgWatcher.tick();
      return reorgPollMs;
    });

    // Aggregator worker. Dormant until `start()` — tests driving
    // ticks manually via InternalPoster never call `start()` and
    // therefore never race with an autonomous worker.
    const aggregatorWorker = new WorkerTimer(async () => {
      const outcome = await aggregatorLoop.tick();
      // Refresh the health latch on every tick so `health().since`
      // reports when the non-ok epoch actually started, not when a
      // consumer next happened to call `health()` (qodo review).
      aggregateHealth();
      switch (outcome) {
        case 'idle':
          return idlePollMs;
        case 'success':
          return 0;
        case 'retry':
          return aggregatorLoop.nextDelayMs();
        case 'permanent':
          return null;
        default:
          return idlePollMs;
      }
    });

    let started = false;
    let stopped = false;

    interface HealthSnapshot {
      state: HealthState;
      reason?: string;
      /**
       * Timestamp the *current* non-ok epoch started. Stable across
       * repeated calls — `/health` consumers use it to tell how long
       * we've been degraded/unhealthy. `undefined` when state is `ok`.
       */
      since?: Date;
    }

    /**
     * Collapse the aggregator's state into a single health snapshot.
     * Pulls reason text from the aggregator-level `permanentlyStopped`
     * flag and backoff attempts so a `/health` consumer can tell what
     * tripped without re-walking the loop internals.
     *
     * `nonOkSince` is latched at the first non-ok observation and
     * cleared when aggregate state returns to ok, so `since` reports
     * when the current non-ok epoch began rather than "right now."
     */
    let nonOkSince: Date | null = null;
    const aggregateHealth = (): HealthSnapshot => {
      const state = aggregatorLoop.healthState();
      let result: HealthSnapshot = { state };
      if (state === 'unhealthy') {
        result = {
          state: 'unhealthy',
          reason: aggregatorLoop.isPermanentlyStopped()
            ? 'aggregator PERMANENT failure — operator must intervene'
            : `aggregator has failed ${aggregatorLoop.attempts()} consecutive submissions`,
        };
      } else if (state === 'degraded') {
        result = {
          state: 'degraded',
          reason: `aggregator has failed ${aggregatorLoop.attempts()} consecutive submissions`,
        };
      }

      // Latch `since` on the first non-ok observation; clear it when
      // we return to ok. Calling `health()` repeatedly during a single
      // non-ok epoch must report the same timestamp.
      if (result.state === 'ok') {
        nonOkSince = null;
      } else {
        if (nonOkSince === null) nonOkSince = now();
        result = { ...result, since: nonOkSince };
      }
      return result;
    };

    const internal: InternalPoster = {
      async submit(message: Uint8Array, hint?: SubmitHint): Promise<SubmitResult> {
        const { state } = aggregateHealth();
        if (state === 'unhealthy') {
          return { accepted: false, reason: 'unhealthy' };
        }
        const canonicalHint: SubmitHint | undefined =
          hint?.contentTag !== undefined
            ? { ...hint, contentTag: canonicalTag(hint.contentTag) }
            : hint;
        return pipeline.ingest(message, canonicalHint);
      },
      async listPending(query?: PendingQuery): Promise<Pending[]> {
        const q: PendingQuery = query ?? {};
        return listPending(
          store,
          q.contentTag !== undefined
            ? { ...q, contentTag: canonicalTag(q.contentTag) }
            : q
        );
      },
      async listSubmittedBatches(
        query?: SubmittedBatchesQuery
      ): Promise<SubmittedBatch[]> {
        const q: SubmittedBatchesQuery = query ?? {};
        return listSubmittedBatches(
          store,
          config.chainId,
          q.contentTag !== undefined
            ? { ...q, contentTag: canonicalTag(q.contentTag) }
            : q
        );
      },
      async status(): Promise<Status> {
        return readStatus({
          store,
          rpc: extras.rpc,
          signer: config.signer,
          configuredTags: allowlistedTags,
          chainId: config.chainId,
        });
      },
      async health(): Promise<Health> {
        const snap = aggregateHealth();
        return readHealth({
          submissionState: snap.state,
          reason: snap.reason,
          since: snap.since,
          aggregator: {
            lastPackedTxHash: aggregatorLoop.lastPackedSnapshot().txHash,
            lastPackedTagCount: aggregatorLoop.lastPackedSnapshot().tagCount,
            permanentlyStopped: aggregatorLoop.isPermanentlyStopped(),
            tags: aggregatorLoop.packingLossSnapshot().map((t) => ({
              contentTag: t.contentTag,
              pendingCount: t.pendingCount,
              packingLossStreak: t.packingLossStreak,
              lastIncludedAt: t.lastIncludedAt,
              warn: t.packingLossStreak >= packingLossWarnThreshold,
            })),
          },
        });
      },
      async start(): Promise<void> {
        if (stopped) throw new Error('Poster: cannot start a stopped instance');
        if (started) return;
        started = true;
        aggregatorWorker.start(0);
        reorgWorker.start(reorgPollMs);
      },
      async stop(): Promise<void> {
        if (stopped) return;
        started = false;
        stopped = true;
        // Cancel timers + drain in-flight ticks before closing the
        // store out from under them.
        await Promise.all([aggregatorWorker.stop(), reorgWorker.stop()]);
        signerRegistry.delete(address);
        await store.close();
      },

      // ── InternalPoster hooks (test-only) ───────────────────────
      async _tickAggregator() {
        return aggregatorLoop.tick();
      },
      async _tickReorgWatcher() {
        return reorgWatcher.tick();
      },
      _started() {
        return started;
      },
      _stopped() {
        return stopped;
      },
    };

    return internal;
  } catch (err) {
    signerRegistry.delete(address);
    throw err;
  }
}

/**
 * Internal test hook: clears the shared-signer registry. Only the
 * Poster's own tests should call this.
 */
export function _clearSignerRegistryForTests(): void {
  signerRegistry.clear();
}
