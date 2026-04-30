/**
 * Cross-tag aggregator (T019).
 *
 * Sits *above* the per-tag `BatchPolicy.select` layer. Each tick:
 *   (a) snapshots pending pools per tag (read-only via `PoolView`),
 *   (b) calls `policy.select(tag, pool, capacity, now)` per tag,
 *   (c) returns no-op if no tag fired,
 *   (d) builds a `PackPlan` via `planPack`,
 *   (e) emits a `PackResult` to the caller (which submits the tx —
 *       see T021),
 *   (f) increments `packingLossStreak[tag]` for every excluded tag
 *       whose pool is non-empty, resets it for every included tag.
 *
 * `maxTagsPerPack` is a constant chosen at construction (not a runtime
 * toggle). Setting it to 1 short-circuits to "select one tag, submit
 * one tx" — the disabled-aggregation shape.
 *
 * The aggregator is pure (no chain calls, no I/O): it returns a
 * `PackResult` describing what to submit. The caller does the actual
 * encoding + transport.
 */

import { encodeBatch, type BAMMessage, type Bytes32 } from 'bam-sdk';

import type {
  BatchPolicy,
  DecodedMessage,
  PoolView,
} from '../types.js';
import {
  defaultPackCapacity,
  planPack,
  type PackPlan,
  type PackPlanIncluded,
  type PerTagSelection,
} from './pack.js';

export interface AggregatorTickInput {
  /** Snapshot of every allowlisted tag's pending pool, oldest-first. */
  pool: PoolView;
  /** Allowlisted content tags considered each tick. */
  tags: readonly Bytes32[];
  /** Wallclock used for `BatchPolicy.select`. */
  now: Date;
}

/**
 * Per-tag selection enriched with the encoded payload bytes that the
 * planner needs. The encoded batch's bytes are the source of truth for
 * `(startFE, endFE)` math; the planner cannot work from message
 * objects alone because the on-chain wire format is decoder-specific
 * (encoded length differs from sum of message bytes).
 */
export interface AggregatorBatchSelection {
  contentTag: Bytes32;
  /**
   * Selected messages (the `BatchPolicy`'s output, before encoding).
   * Useful for the runtime self-check (T020): assert the assembled
   * blob's per-tag slice round-trips to these messages byte-for-byte.
   */
  messages: DecodedMessage[];
  /** Encoded batch bytes (per-tag), the actual segment payload. */
  payloadBytes: Uint8Array;
}

export interface PackResult {
  plan: PackPlan;
  /**
   * Per-tag selections that survived planning, indexed by `contentTag`.
   * The caller (build-and-submit, T021) reads message lists from here
   * to populate substrate writes after the tx confirms.
   */
  includedSelections: ReadonlyMap<Bytes32, AggregatorBatchSelection>;
  /**
   * Excluded tags whose pool was non-empty (a non-empty pool plus an
   * exclusion is what increments the streak counter). Tags with empty
   * pools that produced no selection at all are not in this list.
   */
  excludedTags: readonly Bytes32[];
}

export interface AggregatorTickResult {
  /**
   * `null` when no tag fired its policy this tick (no-op tick — neither
   * counters nor pools mutated; caller should sleep).
   */
  pack: PackResult | null;
}

export interface AggregatorOptions {
  policy: BatchPolicy;
  /** Allowlisted content tags considered each tick. */
  tags: readonly Bytes32[];
  /**
   * Maximum number of per-tag entries the aggregator will pack into
   * one transaction. Construction-time constant. `1` short-circuits
   * to single-tag mode (semantically equivalent to today's per-tag
   * loops).
   */
  maxTagsPerPack: number;
  /** Default capacity from the FE constants; tests inject a narrower one. */
  capacityFEs?: number;
  capacityBytes?: number;
  blobCapacityBytes: number;
  now: () => Date;
  /**
   * Optional encoder override. Defaults to `encodeBatch` from the SDK,
   * which is the same encoder the per-tag loop uses today.
   */
  encodeBatch?: (msgs: BAMMessage[], signatures: Uint8Array[]) => { data: Uint8Array };
}

export interface PackingLossSnapshot {
  contentTag: Bytes32;
  pendingCount: number;
  packingLossStreak: number;
  lastIncludedAt: number | null;
}

export interface Aggregator {
  tick(input: AggregatorTickInput): AggregatorTickResult;
  /** Snapshot of per-tag streak counters for `/health`. */
  packingLossSnapshot(): PackingLossSnapshot[];
}

interface PerTagState {
  packingLossStreak: number;
  lastIncludedAt: number | null;
  /** Last observed pending count (for /health). */
  pendingCount: number;
}

export function createAggregator(opts: AggregatorOptions): Aggregator {
  const state = new Map<Bytes32, PerTagState>();
  for (const tag of opts.tags) {
    state.set(tag, {
      packingLossStreak: 0,
      lastIncludedAt: null,
      pendingCount: 0,
    });
  }
  const encode = opts.encodeBatch ?? encodeBatch;
  const capacity = {
    maxFEs: opts.capacityFEs ?? defaultPackCapacity().maxFEs,
    maxBytes: opts.capacityBytes ?? defaultPackCapacity().maxBytes,
  };

  return {
    tick(input: AggregatorTickInput): AggregatorTickResult {
      const selections: PerTagSelection[] = [];
      const enriched = new Map<Bytes32, AggregatorBatchSelection>();

      // (a) + (b): snapshot + per-tag select.
      for (const tag of opts.tags) {
        const pool = input.pool.list(tag);
        const tagState = state.get(tag)!;
        tagState.pendingCount = pool.length;
        if (pool.length === 0) continue;

        const picked = opts.policy.select(
          tag,
          input.pool,
          opts.blobCapacityBytes,
          input.now
        );
        if (picked === null || picked.msgs.length === 0) continue;

        const oldestIngestedAt = pool[0]!.ingestedAt ?? input.now.getTime();
        const bamMsgs: BAMMessage[] = picked.msgs.map((m) => ({
          sender: m.sender,
          nonce: m.nonce,
          contents: m.contents,
        }));
        const signatures = picked.msgs.map((m) => m.signature);
        const encoded = encode(bamMsgs, signatures);

        selections.push({
          contentTag: tag,
          payloadBytes: encoded.data,
          oldestIngestedAt,
          pendingMessageCount: pool.length,
        });
        enriched.set(tag, {
          contentTag: tag,
          messages: picked.msgs,
          payloadBytes: encoded.data,
        });
      }

      // (c) no fire → no-op.
      if (selections.length === 0) return { pack: null };

      // Cap at `maxTagsPerPack`: planner's oldest-first arbitration
      // already gives a deterministic order; truncate the *sorted*
      // list, then plan against capacity.
      const sortedByAge = [...selections].sort((a, b) =>
        a.oldestIngestedAt !== b.oldestIngestedAt
          ? a.oldestIngestedAt - b.oldestIngestedAt
          : a.contentTag < b.contentTag
            ? -1
            : 1
      );
      const capped = sortedByAge.slice(0, Math.max(1, opts.maxTagsPerPack));
      const cappedExcluded = sortedByAge.slice(Math.max(1, opts.maxTagsPerPack));

      // (d) plan.
      const plan = planPack(capped, capacity);

      // (f) update streaks.
      const includedTags = new Set(plan.included.map((s: PackPlanIncluded) => s.contentTag));
      const excludedTags: Bytes32[] = [
        ...plan.excluded.map((s) => s.contentTag),
        ...cappedExcluded.map((s) => s.contentTag),
      ];
      const nowMs = input.now.getTime();
      for (const tag of opts.tags) {
        const tagState = state.get(tag)!;
        if (includedTags.has(tag)) {
          tagState.packingLossStreak = 0;
          tagState.lastIncludedAt = nowMs;
        } else if (tagState.pendingCount > 0) {
          // Only excluded *with* pending data counts as a loss.
          tagState.packingLossStreak += 1;
        }
      }

      return {
        pack: {
          plan,
          includedSelections: enriched,
          excludedTags,
        },
      };
    },

    packingLossSnapshot(): PackingLossSnapshot[] {
      return opts.tags.map((tag) => {
        const s = state.get(tag)!;
        return {
          contentTag: tag,
          pendingCount: s.pendingCount,
          packingLossStreak: s.packingLossStreak,
          lastIncludedAt: s.lastIncludedAt,
        };
      });
    },
  };
}
