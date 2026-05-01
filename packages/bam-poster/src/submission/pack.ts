/**
 * Multi-tag pack planning — pure functions.
 *
 * Given a per-tag selection (the batch each tag's `BatchPolicy.select`
 * returned), compute a single-blob plan that lays segments at FE-aligned
 * offsets up to capacity, with `min(ingestedAt)` ascending. Excess tags
 * spill into `excluded` and surface as packing-loss-streak signals.
 *
 * Pure: no I/O, no chain stubs, no time. The aggregator (T019) calls
 * `planPack` per tick; the runtime self-check (T020) calls
 * `validatePackPlanInvariants` to refuse to broadcast an inconsistent
 * plan.
 */

import type { Bytes32 } from 'bam-sdk';
import {
  FIELD_ELEMENTS_PER_BLOB,
  USABLE_BYTES_PER_BLOB,
  USABLE_BYTES_PER_FIELD_ELEMENT,
} from 'bam-sdk';

export interface PerTagSelection {
  contentTag: Bytes32;
  /**
   * Encoded payload for this tag's selected batch. The producer knows
   * `payload.length` before assembly; the planner uses it to compute
   * FE-aligned `(startFE, endFE)` and skips tags whose tight FE count
   * doesn't fit in remaining capacity.
   */
  payloadBytes: Uint8Array;
  /**
   * Earliest `ingestedAt` among the messages in this tag's pending pool
   * eligible for inclusion (ms since epoch). Drives oldest-first
   * inclusion order.
   */
  oldestIngestedAt: number;
  /** Pending message count for this tag at snapshot time. */
  pendingMessageCount: number;
}

export interface PackPlanIncluded {
  contentTag: Bytes32;
  startFE: number;
  endFE: number;
  payloadBytes: Uint8Array;
}

export interface PackPlanExcluded {
  contentTag: Bytes32;
  pendingMessageCount: number;
}

export interface PackPlan {
  included: PackPlanIncluded[];
  excluded: PackPlanExcluded[];
}

export interface PackCapacity {
  /**
   * Maximum aggregate `endFE` allowed across included segments. The
   * producer caps this at `FIELD_ELEMENTS_PER_BLOB`; tests cap it
   * lower to exercise overflow behavior without 4096-element fixtures.
   */
  maxFEs: number;
  /**
   * Maximum aggregate payload byte count across included segments.
   * Defaults to `USABLE_BYTES_PER_BLOB` when not set; matches
   * `maxFEs * 31` for production callers.
   */
  maxBytes: number;
}

function feCountForPayload(byteLength: number): number {
  return Math.ceil(byteLength / USABLE_BYTES_PER_FIELD_ELEMENT);
}

/**
 * Compare two `PerTagSelection`s by `min(ingestedAt)` ascending, with
 * `contentTag` lexicographic order as a stable tiebreak. The tiebreak
 * matters because two tags whose oldest pending messages were ingested
 * in the same millisecond would otherwise sort by JS array order.
 */
function compareSelections(a: PerTagSelection, b: PerTagSelection): number {
  if (a.oldestIngestedAt !== b.oldestIngestedAt) {
    return a.oldestIngestedAt - b.oldestIngestedAt;
  }
  return a.contentTag < b.contentTag ? -1 : a.contentTag > b.contentTag ? 1 : 0;
}

/**
 * Compute a single-blob pack plan from a list of per-tag selections.
 *
 * - Sorts ascending by `(oldestIngestedAt, contentTag)` so the oldest
 *   pending message across all tags lands first.
 * - Greedy-fills until the next tag's tight FE count would push the
 *   aggregate past `capacity.maxFEs` (or its tight byte length past
 *   `capacity.maxBytes`).
 * - Excluded tags appear in the result with their pending count so the
 *   aggregator can update per-tag streak counters.
 *
 * Pure: no side effects. The same input produces the same plan every
 * time.
 */
export function planPack(
  input: PerTagSelection[],
  capacity: PackCapacity
): PackPlan {
  const sorted = [...input].sort(compareSelections);
  const included: PackPlanIncluded[] = [];
  const excluded: PackPlanExcluded[] = [];

  let cursorFE = 0;
  let usedBytes = 0;
  for (const selection of sorted) {
    const segmentFEs = feCountForPayload(selection.payloadBytes.length);
    const wouldEndFE = cursorFE + segmentFEs;
    const wouldUseBytes = usedBytes + selection.payloadBytes.length;
    if (
      segmentFEs === 0 ||
      wouldEndFE > capacity.maxFEs ||
      wouldUseBytes > capacity.maxBytes
    ) {
      excluded.push({
        contentTag: selection.contentTag,
        pendingMessageCount: selection.pendingMessageCount,
      });
      continue;
    }
    included.push({
      contentTag: selection.contentTag,
      startFE: cursorFE,
      endFE: wouldEndFE,
      payloadBytes: selection.payloadBytes,
    });
    cursorFE = wouldEndFE;
    usedBytes = wouldUseBytes;
  }

  return { included, excluded };
}

/**
 * Default capacity matching the producer-side blob constants. Use this
 * in production callers; tests pass narrower capacities to drive
 * overflow paths.
 */
export function defaultPackCapacity(): PackCapacity {
  return { maxFEs: FIELD_ELEMENTS_PER_BLOB, maxBytes: USABLE_BYTES_PER_BLOB };
}

/**
 * Assert a `PackPlan` is internally consistent. Throws on any of:
 *   - overlapping `(startFE, endFE)` ranges
 *   - any segment's `endFE > FIELD_ELEMENTS_PER_BLOB`
 *   - inverted or zero-length range
 *   - non-monotonic `startFE` order across `included` (i.e. ranges
 *     listed out-of-order — the planner emits in canonical order;
 *     anything else is a hand-crafted bad plan).
 *
 * Producer-side runtime self-check; refuse to broadcast on violation.
 */
export function validatePackPlanInvariants(plan: PackPlan): void {
  let lastEnd = 0;
  for (const seg of plan.included) {
    if (
      !Number.isInteger(seg.startFE) ||
      !Number.isInteger(seg.endFE) ||
      seg.startFE < 0 ||
      seg.endFE > FIELD_ELEMENTS_PER_BLOB ||
      seg.startFE >= seg.endFE
    ) {
      throw new Error(
        `validatePackPlanInvariants: malformed segment ${seg.contentTag} ` +
          `(startFE=${seg.startFE}, endFE=${seg.endFE})`
      );
    }
    if (seg.startFE < lastEnd) {
      throw new Error(
        `validatePackPlanInvariants: overlap or non-monotonic order at ${seg.contentTag} ` +
          `(startFE=${seg.startFE}, lastEnd=${lastEnd})`
      );
    }
    // The planner produces `endFE - startFE = ceil(payload.length/31)`
    // by construction, so this branch is unreachable for plans the
    // aggregator built. It guards against hand-crafted plans (tests,
    // future callers) where the FE range is too small for the payload —
    // assembly would silently truncate without it.
    const segmentCapacityBytes = (seg.endFE - seg.startFE) * USABLE_BYTES_PER_FIELD_ELEMENT;
    if (seg.payloadBytes.length > segmentCapacityBytes) {
      throw new Error(
        `validatePackPlanInvariants: payload overflows declared range at ${seg.contentTag} ` +
          `(payload=${seg.payloadBytes.length} bytes, capacity=${segmentCapacityBytes} bytes)`
      );
    }
    lastEnd = seg.endFE;
  }
}
