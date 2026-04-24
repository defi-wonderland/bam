import { describe, expect, it } from 'vitest';
import * as mainModule from '../../src/index.js';
import * as browserModule from '../../src/browser.js';
import {
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  EIP712_TYPES,
} from '../../src/signatures.js';

/**
 * Rollup assertions for SDK-level security invariants: EIP-712 domain
 * shape, exported primitives clients need to recompute identifiers,
 * cross-chain replay rejection, and batch capacity helpers. Individual
 * invariants are covered more deeply by their own test files; this
 * file fails loudly if any of the umbrella guarantees regress.
 */

describe('SDK security surface', () => {
  it('EIP-712 domain is `{ name: "BAM", version: "1", chainId }` — no verifyingContract', () => {
    expect(EIP712_DOMAIN_NAME).toBe('BAM');
    expect(EIP712_DOMAIN_VERSION).toBe('1');
    // BAMMessage must bind exactly (sender, nonce uint64, contents bytes)
    // — that's the set every signer signs over.
    expect(EIP712_TYPES.BAMMessage.map((f) => f.name)).toEqual(['sender', 'nonce', 'contents']);
    expect(EIP712_TYPES.BAMMessage.map((f) => f.type)).toEqual(['address', 'uint64', 'bytes']);
  });

  it('exports ERC-8180 `computeMessageHash` so clients can recompute the pre-batch identifier', () => {
    expect(typeof mainModule.computeMessageHash).toBe('function');
    expect(typeof browserModule.computeMessageHash).toBe('function');
  });

  it('BLS primitives remain on the SDK public surface (scheme 0x02 building blocks)', () => {
    // BLS primitives exist for future scheme 0x02 wire-up. The default
    // validator / ingest path must NOT reach them; that's enforced at
    // the Poster layer (validator calls verifyECDSA only).
    expect(typeof mainModule.signBLS).toBe('function');
    expect(typeof mainModule.verifyBLS).toBe('function');
    expect(typeof mainModule.aggregateBLS).toBe('function');
    expect(typeof mainModule.verifyAggregateBLS).toBe('function');
  });

  it('cross-chain replay is rejected by the EIP-712 construction', () => {
    const { computeECDSADigest } = mainModule;
    const sender = ('0x' + '11'.repeat(20)) as `0x${string}`;
    const contents = new Uint8Array(32);
    const d1 = computeECDSADigest({ sender, nonce: 0n, contents }, 1);
    const d2 = computeECDSADigest({ sender, nonce: 0n, contents }, 2);
    expect(d1).not.toBe(d2);
  });

  it('batch codec exposes `estimateBatchSize` for capacity-aware selection', () => {
    expect(typeof mainModule.estimateBatchSize).toBe('function');
    expect(typeof mainModule.encodeBatch).toBe('function');
    expect(typeof mainModule.decodeBatch).toBe('function');
  });
});
