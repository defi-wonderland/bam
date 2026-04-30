/**
 * Cross-runtime parity for `assembleMultiSegmentBlob` / `extractSegmentBytes`.
 *
 * The same input fixture run through the SDK under Node and under jsdom
 * MUST produce byte-identical output. The SHA-256 fingerprints below were
 * captured from a Node run; the matching browser-side test is at
 * `tests/browser/multi-segment-parity.test.ts`. If either side drifts,
 * the runtimes diverged.
 */

import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2';
import { assembleMultiSegmentBlob } from './multi-segment.js';
import { extractSegmentBytes } from './extract.js';
import type { Bytes32 } from '../types.js';

const TAG_A = ('0x' + 'aa'.repeat(32)) as Bytes32;
const TAG_B = ('0x' + 'bb'.repeat(32)) as Bytes32;

const PAYLOAD_A = new Uint8Array(80).fill(0xaa);
const PAYLOAD_B = new Uint8Array(120).fill(0xbb);

const EXPECTED_BLOB_SHA256 =
  '36910001734e691bbdc4755356f243eb46652a94621870305bedc38a66a6fb9c';
const EXPECTED_A_SHA256 =
  'ad6d68ad74b612efba99f5ac205e2564e1516050b883f287b45955fd8d65c835';
const EXPECTED_B_SHA256 =
  '54f92599c5e75e2269d706b07826242957f688caac0d5dc689bdb25194851465';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('multi-segment parity (Node)', () => {
  const { blob, segments } = assembleMultiSegmentBlob([
    { contentTag: TAG_A, payload: PAYLOAD_A },
    { contentTag: TAG_B, payload: PAYLOAD_B },
  ]);

  it('blob sha256 matches the locked vector', () => {
    expect(hex(sha256(blob))).toBe(EXPECTED_BLOB_SHA256);
  });

  it('segments[0] decodes to the locked vector', () => {
    const bytes = extractSegmentBytes(blob, segments[0]!.startFE, segments[0]!.endFE);
    expect(hex(sha256(bytes))).toBe(EXPECTED_A_SHA256);
  });

  it('segments[1] decodes to the locked vector', () => {
    const bytes = extractSegmentBytes(blob, segments[1]!.startFE, segments[1]!.endFE);
    expect(hex(sha256(bytes))).toBe(EXPECTED_B_SHA256);
  });
});
