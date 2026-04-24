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
import { SubmissionLoop } from './submission/loop.js';
import type { BuildAndSubmit } from './submission/types.js';
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
   * Injection hook: the on-chain submission path. If absent, the
   * Poster expects the caller to wire the real viem-backed submitter
   * (see `src/submission/build-and-submit.ts`; not part of the core
   * factory because it pulls the KZG trusted setup).
   */
  buildAndSubmit: BuildAndSubmit;
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
  _tickTag(tag: Bytes32): Promise<'idle' | 'success' | 'retry' | 'permanent' | undefined>;
  _tickReorgWatcher(): Promise<{ reorgedCount: number; keptCount: number }>;
  _started(): boolean;
  _stopped(): boolean;
}

const DEFAULT_IDLE_POLL_MS = 1_000;
const DEFAULT_REORG_POLL_MS = 12_000;

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
 * `start()` spawns autonomous per-tag submission workers + a
 * reorg-watcher worker; `stop()` cancels them and drains in-flight
 * ticks before closing the store.
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

    const store: BamStore = config.store ?? createMemoryStore();
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

    // One submission loop per tag.
    const loops = new Map<Bytes32, SubmissionLoop>();
    for (const tag of allowlistedTags) {
      loops.set(
        tag,
        new SubmissionLoop({
          tag,
          chainId: config.chainId,
          store,
          policy: batchPolicy,
          blobCapacityBytes: blobCapacity,
          buildAndSubmit: extras.buildAndSubmit,
          backoff,
          now,
          reorgWindowBlocks: reorgWindow,
          logger,
        })
      );
    }

    const reorgWatcher = new ReorgWatcher({
      store,
      blockSource: extras.rpc,
      reorgWindowBlocks: reorgWindow,
      now,
    });

    // Per-tag workers + reorg watcher. Dormant until `start()` —
    // tests driving ticks manually via InternalPoster never call
    // `start()` and therefore never race with an autonomous worker.
    const tagWorkers = new Map<Bytes32, WorkerTimer>();
    for (const [tag, loop] of loops) {
      tagWorkers.set(
        tag,
        new WorkerTimer(async () => {
          const outcome = await loop.tick();
          // Refresh the health latch on every tick so `health().since`
          // reports when the non-ok epoch actually started, not when a
          // consumer next happened to call `health()` (qodo review).
          aggregateHealth();
          switch (outcome) {
            case 'idle':
              return idlePollMs;
            case 'success':
              return 0; // immediate next round
            case 'retry':
              return loop.nextDelayMs();
            case 'permanent':
              return null; // stop the worker
            default:
              return idlePollMs;
          }
        })
      );
    }
    const reorgWorker = new WorkerTimer(async () => {
      await reorgWatcher.tick();
      return reorgPollMs;
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
     * Collapse per-tag loop states into a single health snapshot.
     * When any loop is non-ok we also surface a short reason so the
     * `/health` consumer can tell what tripped (e.g. "tag
     * 0xabc… has failed 7 consecutive submissions"). Strictly textual —
     * no structured fields, no PII.
     *
     * `nonOkSince` is latched at the first non-ok observation and
     * cleared when aggregate state returns to ok, so `since` reports
     * when the current non-ok epoch began rather than "right now."
     */
    let nonOkSince: Date | null = null;
    const aggregateHealth = (): HealthSnapshot => {
      let result: HealthSnapshot = { state: 'ok' };
      let worst: HealthState = 'ok';
      let worstTag: Bytes32 | null = null;
      let worstAttempts = 0;
      for (const [tag, l] of loops) {
        const s = l.healthState();
        if (s === 'unhealthy') {
          result = {
            state: 'unhealthy',
            reason: `tag ${tag} has failed ${l.attempts()} consecutive submissions`,
          };
          worst = 'unhealthy';
          break;
        }
        if (s === 'degraded' && worst === 'ok') {
          worst = 'degraded';
          worstTag = tag;
          worstAttempts = l.attempts();
        }
      }
      if (worst === 'degraded' && worstTag !== null) {
        result = {
          state: 'degraded',
          reason: `tag ${worstTag} has failed ${worstAttempts} consecutive submissions`,
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
        });
      },
      async health(): Promise<Health> {
        const snap = aggregateHealth();
        return readHealth({
          submissionState: snap.state,
          reason: snap.reason,
          since: snap.since,
        });
      },
      async start(): Promise<void> {
        if (stopped) throw new Error('Poster: cannot start a stopped instance');
        if (started) return;
        started = true;
        for (const worker of tagWorkers.values()) worker.start(0);
        reorgWorker.start(reorgPollMs);
      },
      async stop(): Promise<void> {
        if (stopped) return;
        started = false;
        stopped = true;
        // Cancel timers + drain in-flight ticks before closing the
        // store out from under them.
        const pending: Promise<void>[] = [];
        for (const worker of tagWorkers.values()) pending.push(worker.stop());
        pending.push(reorgWorker.stop());
        await Promise.all(pending);
        signerRegistry.delete(address);
        await store.close();
      },

      // ── InternalPoster hooks (test-only) ───────────────────────
      async _tickTag(tag: Bytes32) {
        return loops.get(canonicalTag(tag))?.tick();
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
