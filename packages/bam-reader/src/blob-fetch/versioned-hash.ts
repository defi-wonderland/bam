/**
 * Versioned-hash recompute + assertion helpers.
 *
 * Every blob we obtain from an off-chain source (beacon API, Blobscan,
 * etc.) is independently re-hashed and matched against the
 * `BlobBatchRegistered` event's `blobVersionedHash`. A mismatch means
 * the source returned bytes that are *not* the chain-endorsed payload
 * — we reject those bytes (red-team C-2).
 */

import { commitToBlob, loadTrustedSetup } from 'bam-sdk';
import type { Bytes32 } from 'bam-sdk';

import { VersionedHashMismatch } from '../errors.js';
import {
  BYTES_PER_FIELD_ELEMENT,
  FIELD_ELEMENTS_PER_BLOB,
} from './extract.js';

export const FULL_BLOB_BYTE_LENGTH =
  FIELD_ELEMENTS_PER_BLOB * BYTES_PER_FIELD_ELEMENT;

let trustedSetupReady = false;

function ensureTrustedSetup(): void {
  if (trustedSetupReady) return;
  loadTrustedSetup();
  trustedSetupReady = true;
}

/**
 * Recompute the EIP-4844 versioned hash from a 4096-FE blob.
 * Returns a lower-cased `0x`-prefixed 32-byte hex string matching the
 * value the chain emits in `BlobBatchRegistered.versionedHash`.
 */
export function recomputeVersionedHash(blobBytes: Uint8Array): Bytes32 {
  if (blobBytes.length !== FULL_BLOB_BYTE_LENGTH) {
    throw new RangeError(
      `expected ${FULL_BLOB_BYTE_LENGTH}-byte blob, got ${blobBytes.length}`
    );
  }
  ensureTrustedSetup();
  const { versionedHash } = commitToBlob(blobBytes);
  return versionedHash.toLowerCase() as Bytes32;
}

/** Lower-case hex normalisation; tolerant of missing `0x`. */
function normaliseHash(h: string): string {
  const lower = h.toLowerCase();
  return lower.startsWith('0x') ? lower : `0x${lower}`;
}

/**
 * Throw `VersionedHashMismatch` if the recomputed versioned hash of
 * `blobBytes` does not equal `expectedHash`. No-op on match.
 */
export function assertVersionedHashMatches(
  blobBytes: Uint8Array,
  expectedHash: Bytes32
): void {
  const got = recomputeVersionedHash(blobBytes);
  const want = normaliseHash(expectedHash);
  if (got !== want) {
    throw new VersionedHashMismatch(
      `versioned hash mismatch: expected ${want}, got ${got}`
    );
  }
}
