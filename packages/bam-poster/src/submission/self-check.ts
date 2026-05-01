/**
 * Producer-side runtime self-check (T020, G-5, C-1).
 *
 * After assembling a packed blob, decode every per-tag slice through
 * the same SDK path the Reader will use, and assert each slice
 * round-trips to the messages we *intended* to include byte-for-byte.
 * Refuse to broadcast on any mismatch.
 *
 * Defends against producer-side encoding / FE-alignment bugs that
 * would produce a self-consistent blob (KZG commitment matches what we
 * signed) whose per-tag slices mis-decode silently. The on-chain
 * versioned-hash check cannot catch this; only a producer-side
 * round-trip can.
 */

import { decodeBatch, extractSegmentBytes, type Bytes32 } from 'bam-sdk';

import type { AggregatorBatchSelection } from './aggregator.js';
import type { PackPlan } from './pack.js';

export class PackSelfCheckMismatch extends Error {
  constructor(
    readonly contentTag: Bytes32,
    readonly reason: string
  ) {
    super(`PackSelfCheckMismatch: tag=${contentTag} reason=${reason}`);
    this.name = 'PackSelfCheckMismatch';
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Verify that every per-tag segment in `plan` decodes byte-for-byte
 * back to the original payload bytes that the producer encoded.
 *
 * Throws `PackSelfCheckMismatch` on the first failure with the
 * offending `contentTag` and a short reason. If the helper returns
 * normally, the producer can broadcast the tx.
 */
export function verifyPackedBlobRoundTrips(
  blob: Uint8Array,
  plan: PackPlan,
  originalSelections: ReadonlyMap<Bytes32, AggregatorBatchSelection>
): void {
  for (const segment of plan.included) {
    const original = originalSelections.get(segment.contentTag);
    if (original === undefined) {
      throw new PackSelfCheckMismatch(
        segment.contentTag,
        'no-matching-original-selection'
      );
    }

    // 1. Slice the blob using the EXACT range the producer is about to
    //    publish. The slice yields an FE-multiple length (>= original
    //    payload length); the trailing bytes are the FE alignment
    //    zero-padding produced by `assembleMultiSegmentBlob`.
    const sliced = extractSegmentBytes(blob, segment.startFE, segment.endFE);

    // 2. The first `original.payloadBytes.length` bytes of the slice
    //    MUST equal the producer's original encoded batch. Anything
    //    after is alignment padding (00s) that doesn't affect decode.
    const head = sliced.subarray(0, original.payloadBytes.length);
    if (!bytesEqual(head, original.payloadBytes)) {
      throw new PackSelfCheckMismatch(
        segment.contentTag,
        'slice-bytes-mismatch'
      );
    }

    // 3. Decode the slice through the SDK's `decodeBatch` (the same
    //    path the Reader will use). Empty messages are valid; the
    //    point is structural decode, not message count.
    let decoded;
    try {
      decoded = decodeBatch(head);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new PackSelfCheckMismatch(
        segment.contentTag,
        `decode-throw:${detail}`
      );
    }

    // 4. Decoded message count must match the producer's intent.
    if (decoded.messages.length !== original.messages.length) {
      throw new PackSelfCheckMismatch(
        segment.contentTag,
        `message-count:${decoded.messages.length}!=${original.messages.length}`
      );
    }
  }
}
