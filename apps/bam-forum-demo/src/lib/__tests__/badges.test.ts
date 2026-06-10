import { describe, expect, it } from 'vitest';

import { badgeForConfirmed, resolveBadges } from '../badges';
import type {
  ProofSummaryEntry,
  ValidationEntry,
} from '../coprocessor-client';

function validation(messageHash: string, provenAt: string): ValidationEntry {
  return {
    messageHash,
    chainId: 11155111,
    versionedHash: '0x01' + '00'.repeat(31),
    contentTag: '0x01bc15' + '00'.repeat(29),
    startFe: 0,
    endFe: 4096,
    blockNumber: 1,
    txIndex: 0,
    msgIndex: 0,
    sender: '0x' + '11'.repeat(20),
    nonce: '0',
    cycles: 26_000_000,
    validatedAt: provenAt,
  };
}

function proof(messageHash: string, provenAt: string): ProofSummaryEntry {
  return {
    messageHash,
    chainId: 11155111,
    versionedHash: '0x01' + '00'.repeat(31),
    contentTag: '0x01bc15' + '00'.repeat(29),
    startFe: 0,
    endFe: 4096,
    blockNumber: 1,
    txIndex: 0,
    msgIndex: 0,
    sender: '0x' + '11'.repeat(20),
    nonce: '0',
    cycles: 26_000_000,
    proofSize: 1832,
    proofType: 'groth16',
    requestId: '0x' + 'aa'.repeat(32),
    txHash: null,
    sp1Version: 'sp1-v6.1.0',
    provenAt,
  };
}

describe('resolveBadges', () => {
  it('returns confirmed for messages not in V or P', () => {
    const index = resolveBadges({ validations: [], proofs: [] });
    expect(badgeForConfirmed(index, '0xabc').status).toBe('confirmed');
    expect(index.validatedCount).toBe(0);
    expect(index.provenCount).toBe(0);
    expect(index.latestProvenAt).toBeNull();
  });

  it('marks validated when in V but not P', () => {
    const v = validation('0xabc', '2026-06-05T00:00:00Z');
    const index = resolveBadges({ validations: [v], proofs: [] });
    expect(badgeForConfirmed(index, '0xabc').status).toBe('validated');
    expect(index.validatedCount).toBe(1);
  });

  it('marks proven when in P (regardless of V), with commitment metadata', () => {
    const v = validation('0xabc', '2026-06-05T00:00:00Z');
    const p = proof('0xabc', '2026-06-05T01:00:00Z');
    const index = resolveBadges({ validations: [v], proofs: [p] });
    const resolved = badgeForConfirmed(index, '0xabc');
    expect(resolved.status).toBe('proven');
    expect(resolved.proofCommitment?.proofType).toBe('groth16');
    expect(resolved.proofCommitment?.sp1Version).toBe('sp1-v6.1.0');
  });

  it('latestProvenAt is the max provenAt across the proof set', () => {
    const older = proof('0xa', '2026-06-04T10:00:00Z');
    const newer = proof('0xb', '2026-06-05T01:00:00Z');
    const index = resolveBadges({ validations: [], proofs: [older, newer] });
    expect(index.latestProvenAt).toBe('2026-06-05T01:00:00Z');
  });

  it('messageHash lookup is case-insensitive', () => {
    const v = validation('0xABCDEF', '2026-06-05T00:00:00Z');
    const index = resolveBadges({ validations: [v], proofs: [] });
    expect(badgeForConfirmed(index, '0xabcdef').status).toBe('validated');
    expect(badgeForConfirmed(index, '0xABCDEF').status).toBe('validated');
  });
});
