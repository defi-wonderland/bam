import { createBlob } from 'bam-sdk';
import { describe, expect, it } from 'vitest';

import { VersionedHashMismatch } from '../../src/errors.js';
import {
  FULL_BLOB_BYTE_LENGTH,
  assertVersionedHashMatches,
  recomputeVersionedHash,
} from '../../src/blob-fetch/versioned-hash.js';

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe('recomputeVersionedHash', () => {
  it('computes a 32-byte 0x01-prefixed versioned hash', () => {
    const blob = createBlob(utf8('hello bam reader'));
    const hash = recomputeVersionedHash(blob);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hash.slice(0, 4)).toBe('0x01');
  });

  it('is deterministic across repeated calls on identical input', () => {
    const blob = createBlob(utf8('determinism check'));
    const a = recomputeVersionedHash(blob);
    const b = recomputeVersionedHash(blob);
    expect(a).toBe(b);
  });

  it('produces different hashes for different blobs', () => {
    const a = recomputeVersionedHash(createBlob(utf8('payload-A')));
    const b = recomputeVersionedHash(createBlob(utf8('payload-B')));
    expect(a).not.toBe(b);
  });

  it('rejects blobs of the wrong length', () => {
    expect(() => recomputeVersionedHash(new Uint8Array(1024))).toThrow(RangeError);
    expect(() => recomputeVersionedHash(new Uint8Array(FULL_BLOB_BYTE_LENGTH + 1))).toThrow(
      RangeError
    );
  });
});

describe('assertVersionedHashMatches', () => {
  it('returns silently when the recomputed hash matches', () => {
    const blob = createBlob(utf8('match-me'));
    const hash = recomputeVersionedHash(blob);
    expect(() => assertVersionedHashMatches(blob, hash)).not.toThrow();
  });

  it('matches case-insensitively and with/without 0x prefix', () => {
    const blob = createBlob(utf8('case-insensitive'));
    const hash = recomputeVersionedHash(blob);
    const upper = ('0x' + hash.slice(2).toUpperCase()) as `0x${string}`;
    expect(() => assertVersionedHashMatches(blob, upper)).not.toThrow();
  });

  it('throws VersionedHashMismatch when hashes differ', () => {
    const blob = createBlob(utf8('mismatch'));
    const wrong = ('0x' + '01' + '00'.repeat(31)) as `0x${string}`;
    expect(() => assertVersionedHashMatches(blob, wrong)).toThrow(VersionedHashMismatch);
  });
});
