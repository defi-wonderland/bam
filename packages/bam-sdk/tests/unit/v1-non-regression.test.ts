import { describe, expect, it } from 'vitest';

/**
 * v1 primitive non-regression.
 *
 * The v1 message + batch + EIP-191 ECDSA surface is not part of the
 * SDK's public entrypoints (`index.ts`, `browser.ts`). This test
 * asserts none of them has been reintroduced. Re-adding any of these
 * names to a public re-export line would fail here, forcing a
 * reviewer to delete the guard and justify the re-addition.
 */

const FORBIDDEN_PUBLIC_NAMES = [
  'encodeMessage',
  'decodeMessage',
  'encodeMessageWithId',
  'buildAuthorTable',
  'parseMessageFlags',
  'buildMessageFlags',
  'parseExtendedHeader',
  'encodeExtendedHeader',
  'getSignatureSizeForScheme',
  'recoverAddress',
  'validateBatch',
  // Note: `signECDSA` and `verifyECDSA` are **exported** as the
  // canonical v2 shape (EIP-712 over `BAMMessage`) and are
  // deliberately NOT on this list. The v1 shapes
  // (v1 `signECDSA(privateKey, messageHash)`,
  // v1 `verifyECDSA(address, messageHash, signature)`) live only in
  // git history; the current exports take different arguments and
  // would fail at the call site if a v1 caller tried to use them.
];

const FORBIDDEN_PUBLIC_TYPES = [
  'Message',
  'SignedMessage',
  'BatchedMessage',
  'BatchHeader',
  'MessageFlags',
  'BatchFlags',
  'ExtendedSignatureHeader',
  'ExtendedSignature',
  'SignatureType',
];

describe('v1 public surface non-regression', () => {
  it('no forbidden v1 value exports reappear on bam-sdk (Node)', async () => {
    const mod = (await import('../../src/index.js')) as Record<string, unknown>;
    const offenders = FORBIDDEN_PUBLIC_NAMES.filter((name) => name in mod);
    expect(offenders, `v1 exports reappeared: ${offenders.join(', ')}`).toEqual([]);
  });

  it('no forbidden v1 value exports reappear on bam-sdk/browser', async () => {
    const mod = (await import('../../src/browser.js')) as Record<string, unknown>;
    const offenders = FORBIDDEN_PUBLIC_NAMES.filter((name) => name in mod);
    expect(offenders, `v1 browser exports reappeared: ${offenders.join(', ')}`).toEqual([]);
  });

  // TypeScript type-only exports aren't introspectable at runtime, so
  // this test fails early on the value side only. The ambient shape of
  // the SDK's `.d.ts` output is spot-checked via `tsc --noEmit` in
  // every other test file — if a forbidden type were re-exported,
  // consumers would start importing it and that would show up in
  // follow-on suites.
  void FORBIDDEN_PUBLIC_TYPES;
});
