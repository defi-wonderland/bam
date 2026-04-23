import { estimateBatchSize, type Message } from 'bam-sdk';
import type { Bytes32 } from 'bam-sdk';

import type { BatchPolicy, DecodedMessage, PoolView } from '../types.js';

/**
 * Default blob-capacity exposed to the policy. Leaves headroom under
 * the 128 KiB EIP-4844 blob cap for batch framing and compression
 * slack (plan §C-5).
 */
export const DEFAULT_BLOB_CAPACITY_BYTES = 126 * 1024;

export interface DefaultBatchPolicyConfig {
  /** Fire when pending size (bytes) would fill a blob up to this ratio. */
  sizeTriggerRatio?: number;
  /** Fire when the oldest pending message has been waiting ≥ this many ms. */
  ageTriggerMs?: number;
  /**
   * Fire when the pool holds at least this many messages for the tag,
   * regardless of size/age. 0 disables.
   */
  countTrigger?: number;
  /** Override — force submission on every tick. Used by manual flush. */
  forceFlush?: boolean;
}

/**
 * Per-tag FIFO selection under blob capacity (plan §C-5).
 *
 * - Walks the tag's pending pool in ingest order, greedy-adding
 *   messages so long as the resulting batch fits under
 *   `blobCapacityBytes`.
 * - Returns `null` if the selected set is empty — the submission loop
 *   short-circuits rather than issuing an empty batch.
 * - Triggers: size (pending would roughly fill a blob), age (oldest
 *   pending is old enough), or explicit-flush (force).
 *
 * All trigger params are tunable. Defaults are reasonable for the
 * demo's message-in-a-blobble load (short utf-8 messages; traffic
 * bursts under minutes).
 */
export function defaultBatchPolicy(
  config: DefaultBatchPolicyConfig = {}
): BatchPolicy {
  const sizeTriggerRatio = config.sizeTriggerRatio ?? 0.75;
  const ageTriggerMs = config.ageTriggerMs ?? 60_000;
  const countTrigger = config.countTrigger ?? 8;

  return {
    select(
      tag: Bytes32,
      pool: PoolView,
      blobCapacityBytes: number,
      now: Date
    ): { msgs: DecodedMessage[] } | null {
      const pending = pool.list(tag);
      if (pending.length === 0) return null;

      // Greedy, capacity-aware FIFO walk.
      const picked: DecodedMessage[] = [];
      for (const next of pending) {
        const candidate = [...picked, next];
        const size = estimateBatchSize(candidate.map(toSdkMessage));
        if (size > blobCapacityBytes) break;
        picked.push(next);
      }
      if (picked.length === 0) return null;

      if (config.forceFlush) return { msgs: picked };

      // Size trigger: selected set already fills enough of a blob.
      const selectedSize = estimateBatchSize(picked.map(toSdkMessage));
      if (selectedSize >= blobCapacityBytes * sizeTriggerRatio) {
        return { msgs: picked };
      }

      // Age trigger: oldest picked message has been pending too long.
      // Use `ingestedAt` (Poster-side, not caller-controlled); the
      // author-signed `timestamp` is attacker-controlled and would let
      // a malicious client set a far-future timestamp to prevent the
      // age trigger from ever firing for their batch.
      //
      // `ingestedAt` is absent on a freshly-decoded message (not yet in
      // the pool). The submission-loop path always reads rows out of
      // the pool before handing them here, so it's populated in
      // practice; if it's missing, skip the age trigger rather than
      // falling back to the signed timestamp.
      const oldestIngestMs = picked[0].ingestedAt;
      if (typeof oldestIngestMs === 'number') {
        const ageMs = now.getTime() - oldestIngestMs;
        if (ageMs >= ageTriggerMs) return { msgs: picked };
      }

      // Count trigger.
      if (countTrigger > 0 && picked.length >= countTrigger) {
        return { msgs: picked };
      }

      return null;
    },
  };
}

function toSdkMessage(d: DecodedMessage): Message {
  return {
    author: d.author,
    timestamp: d.timestamp,
    nonce: Number(d.nonce & 0xffffn),
    content: d.content,
  };
}
