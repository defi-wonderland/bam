import {
  BATCH_HEADER_FIXED_SIZE,
  BLOB_USABLE_CAPACITY,
  MESSAGE_HEADER_SIZE,
} from 'bam-sdk';

import type { ValidationResult } from '../types.js';

/**
 * Extra slack under blob capacity — covers ZSTD framing overhead, the
 * author table (up to 255 × 20 bytes), and the per-message envelope
 * that the Poster wraps around the wire bytes. 4 KiB is conservative
 * but still leaves ~95% of the blob for content.
 */
const BATCH_FRAMING_SLACK = 4_096;

/**
 * Default per-message size bound, derived from the SDK's blob-usable
 * capacity minus batch header + message header + framing slack. A
 * single message at or below this bound must always encode into a
 * single full blob without overflow; a message larger than this
 * can't possibly be batched and should be rejected at ingest before
 * any crypto work (B-2).
 *
 * Operators can override via `PosterConfig.maxMessageSizeBytes`.
 */
export const DEFAULT_MAX_MESSAGE_SIZE_BYTES =
  BLOB_USABLE_CAPACITY - BATCH_HEADER_FIXED_SIZE - MESSAGE_HEADER_SIZE - BATCH_FRAMING_SLACK;

/**
 * Runs before any parsing or crypto. Rejects oversized payloads before
 * the validator can burn CPU on them (B-2, plan §Security impact).
 */
export function checkSizeBound(raw: Uint8Array, maxBytes: number): ValidationResult {
  if (raw.byteLength > maxBytes) {
    return { ok: false, reason: 'message_too_large' };
  }
  return { ok: true };
}
