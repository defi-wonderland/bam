/**
 * ECDSA registry envelope helpers — known-vector tests.
 *
 * Vectors are generated from `packages/bam-contracts` via a one-shot Forge
 * test that logs `abi.encode(...)` + `keccak256(...)` and the
 * `personal_sign`-wrapped digest; the expected values below match that
 * output byte-for-byte. If you change `POP_DOMAIN` or the encoding you must
 * regenerate these vectors from the contract side.
 */

import { describe, expect, it } from 'vitest';

import { computeEcdsaPopMessage, wrapPersonalSign } from '../../src/signatures.js';
import { ECDSA_POP_DOMAIN } from '../../src/constants.js';
import type { Address, HexBytes } from '../../src/types.js';

const REGISTRY: Address = '0x0000000000000000000000000000000000000001';
const OWNER: Address = '0x0000000000000000000000000000000000000002';

// abi.encode("ERC-BAM-ECDSA-PoP.v1", 1, REGISTRY, OWNER) → keccak256:
const EXPECTED_POP_INNER: HexBytes =
  '0x779c04d652623e986532980907939c9641194b9cc816d9d571d9cd6bdc4c5714';

// keccak256("\x19Ethereum Signed Message:\n32" || EXPECTED_POP_INNER):
const EXPECTED_POP_SIGNED: HexBytes =
  '0xd16a778fbbeb000e925b07867d1f74f79b0b0067fb4a5b157f2a4c074e7e4d81';

describe('ECDSA envelope helpers', () => {
  describe('ECDSA_POP_DOMAIN', () => {
    it('matches the contract constant', () => {
      expect(ECDSA_POP_DOMAIN).toBe('ERC-BAM-ECDSA-PoP.v1');
    });
  });

  describe('computeEcdsaPopMessage', () => {
    it('matches contract-generated vector for (chainId=1, reg=0x..01, owner=0x..02)', () => {
      const inner = computeEcdsaPopMessage({
        owner: OWNER,
        chainId: 1,
        registry: REGISTRY,
      });
      expect(inner).toBe(EXPECTED_POP_INNER);
    });

    it('accepts bigint and number chainId equivalently', () => {
      const asNumber = computeEcdsaPopMessage({
        owner: OWNER,
        chainId: 1,
        registry: REGISTRY,
      });
      const asBigint = computeEcdsaPopMessage({
        owner: OWNER,
        chainId: 1n,
        registry: REGISTRY,
      });
      expect(asNumber).toBe(asBigint);
    });

    it('is sensitive to owner — changing owner changes the hash', () => {
      const a = computeEcdsaPopMessage({ owner: OWNER, chainId: 1, registry: REGISTRY });
      const b = computeEcdsaPopMessage({
        owner: '0x0000000000000000000000000000000000000003',
        chainId: 1,
        registry: REGISTRY,
      });
      expect(a).not.toBe(b);
    });

    it('is sensitive to registry — changing registry changes the hash', () => {
      const a = computeEcdsaPopMessage({ owner: OWNER, chainId: 1, registry: REGISTRY });
      const b = computeEcdsaPopMessage({
        owner: OWNER,
        chainId: 1,
        registry: '0x0000000000000000000000000000000000000099',
      });
      expect(a).not.toBe(b);
    });

    it('is sensitive to chainId — mainnet vs sepolia differ', () => {
      const mainnet = computeEcdsaPopMessage({ owner: OWNER, chainId: 1, registry: REGISTRY });
      const sepolia = computeEcdsaPopMessage({
        owner: OWNER,
        chainId: 11155111,
        registry: REGISTRY,
      });
      expect(mainnet).not.toBe(sepolia);
    });
  });

  describe('wrapPersonalSign', () => {
    it('matches contract-generated vector for the PoP inner hash', () => {
      const wrapped = wrapPersonalSign(EXPECTED_POP_INNER);
      expect(wrapped).toBe(EXPECTED_POP_SIGNED);
    });

    it('rejects hashes of the wrong length', () => {
      expect(() => wrapPersonalSign('0xdeadbeef' as HexBytes)).toThrow(
        /32-byte hash/
      );
    });

    it('is a stable function of its input', () => {
      const inner = computeEcdsaPopMessage({
        owner: OWNER,
        chainId: 1,
        registry: REGISTRY,
      });
      expect(wrapPersonalSign(inner)).toBe(wrapPersonalSign(inner));
    });
  });
});
