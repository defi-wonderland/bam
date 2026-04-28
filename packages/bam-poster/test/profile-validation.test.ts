import { describe, expect, it } from 'vitest';
import { zeroAddress } from 'viem';

import type { Address } from 'bam-sdk';
import type { ChainDeployment } from 'bam-sdk';

import { EnvConfigError, parseEnv } from '../src/bin/env.js';
import {
  resolveProfileAddresses,
  type DeploymentsLookup,
} from '../src/profile.js';

const BASE_ENV = {
  POSTER_ALLOWED_TAGS: '0x' + 'aa'.repeat(32),
  POSTER_CHAIN_ID: '11155111',
  POSTER_BAM_CORE_ADDRESS: '0x9C4b230066a6808D83F5FBa0c040E0Df2Fcc7314',
  POSTER_RPC_URL: 'http://localhost:8545',
  POSTER_SIGNER_PRIVATE_KEY: '0x' + 'ab'.repeat(32),
};

const ECDSA_REGISTRY: Address = '0xF4Ce909305a112C2CBEC6b339a42f34bA8bf3381';
const ABI_DECODER: Address = '0x0123456789abcdef0123456789abcdef01234567';

function makeLookup(deployment?: ChainDeployment): DeploymentsLookup {
  return (chainId: number) =>
    deployment && deployment.chainId === chainId ? deployment : undefined;
}

describe('POSTER_BATCH_PROFILE × deployment lookup', () => {
  // (a) default + no SDK entry → ok
  it('default + no SDK entry → ok with zero addresses', () => {
    const env = parseEnv({ ...BASE_ENV });
    expect(env.batchProfile).toBe('default');
    const resolved = resolveProfileAddresses(env.batchProfile, env.chainId, makeLookup());
    expect(resolved.decoderAddress).toBe(zeroAddress);
    expect(resolved.signatureRegistryAddress).toBe(zeroAddress);
  });

  // (b) default + entry present → ok, addresses zero
  it('default + entry present → ok with zero addresses (entry ignored)', () => {
    const env = parseEnv({ ...BASE_ENV });
    const lookup = makeLookup({
      chainId: 11155111,
      name: 'sepolia',
      contracts: {
        ECDSARegistry: { address: ECDSA_REGISTRY },
        ABIDecoder: { address: ABI_DECODER },
      },
    });
    const resolved = resolveProfileAddresses(env.batchProfile, env.chainId, lookup);
    expect(resolved.decoderAddress).toBe(zeroAddress);
    expect(resolved.signatureRegistryAddress).toBe(zeroAddress);
  });

  // (c) canonical-registry + no entry → fail-fast naming chain id
  it('canonical-registry + no SDK entry → fail-fast naming the chain id', () => {
    const env = parseEnv({ ...BASE_ENV, POSTER_BATCH_PROFILE: 'canonical-registry' });
    expect(() => resolveProfileAddresses(env.batchProfile, env.chainId, makeLookup())).toThrow(
      /chain 11155111/
    );
  });

  // (d) canonical-registry + entry without ECDSARegistry → fail-fast naming the missing contract
  it('canonical-registry + entry without ECDSARegistry → fail-fast naming the missing contract', () => {
    const env = parseEnv({ ...BASE_ENV, POSTER_BATCH_PROFILE: 'canonical-registry' });
    const lookup = makeLookup({
      chainId: 11155111,
      name: 'sepolia',
      contracts: {},
    });
    expect(() => resolveProfileAddresses(env.batchProfile, env.chainId, lookup)).toThrow(
      /ECDSARegistry/
    );
  });

  // (e) canonical-registry + entry with ECDSARegistry → ok, decoder zero, registry non-zero
  it('canonical-registry + entry with ECDSARegistry → decoder zero, registry non-zero', () => {
    const env = parseEnv({ ...BASE_ENV, POSTER_BATCH_PROFILE: 'canonical-registry' });
    const lookup = makeLookup({
      chainId: 11155111,
      name: 'sepolia',
      contracts: { ECDSARegistry: { address: ECDSA_REGISTRY } },
    });
    const resolved = resolveProfileAddresses(env.batchProfile, env.chainId, lookup);
    expect(resolved.decoderAddress).toBe(zeroAddress);
    expect(resolved.signatureRegistryAddress).toBe(ECDSA_REGISTRY);
  });

  // (f) canonical-full + no ABIDecoder → fail-fast naming ABIDecoder
  it('canonical-full + no ABIDecoder → fail-fast naming ABIDecoder', () => {
    const env = parseEnv({ ...BASE_ENV, POSTER_BATCH_PROFILE: 'canonical-full' });
    const lookup = makeLookup({
      chainId: 11155111,
      name: 'sepolia',
      contracts: { ECDSARegistry: { address: ECDSA_REGISTRY } },
    });
    expect(() => resolveProfileAddresses(env.batchProfile, env.chainId, lookup)).toThrow(
      /ABIDecoder/
    );
  });

  // (g) canonical-full + both present → both non-zero
  it('canonical-full + both present → both non-zero', () => {
    const env = parseEnv({ ...BASE_ENV, POSTER_BATCH_PROFILE: 'canonical-full' });
    const lookup = makeLookup({
      chainId: 11155111,
      name: 'sepolia',
      contracts: {
        ECDSARegistry: { address: ECDSA_REGISTRY },
        ABIDecoder: { address: ABI_DECODER },
      },
    });
    const resolved = resolveProfileAddresses(env.batchProfile, env.chainId, lookup);
    expect(resolved.decoderAddress).toBe(ABI_DECODER);
    expect(resolved.signatureRegistryAddress).toBe(ECDSA_REGISTRY);
  });

  // (h) canonical-full + POSTER_DECODER_ADDRESS set → fail-fast on conflict
  it('canonical-full + POSTER_DECODER_ADDRESS set → fail-fast on conflict', () => {
    expect(() =>
      parseEnv({
        ...BASE_ENV,
        POSTER_BATCH_PROFILE: 'canonical-full',
        POSTER_DECODER_ADDRESS: ABI_DECODER,
      })
    ).toThrow(EnvConfigError);
    expect(() =>
      parseEnv({
        ...BASE_ENV,
        POSTER_BATCH_PROFILE: 'canonical-full',
        POSTER_DECODER_ADDRESS: ABI_DECODER,
      })
    ).toThrow(/POSTER_DECODER_ADDRESS/);
  });

  // (i) default + POSTER_DECODER_ADDRESS set → warn but proceed
  it('default + POSTER_DECODER_ADDRESS set → warns but proceeds', () => {
    const warnings: string[] = [];
    const env = parseEnv(
      { ...BASE_ENV, POSTER_DECODER_ADDRESS: ABI_DECODER },
      (msg) => warnings.push(msg)
    );
    expect(env.batchProfile).toBe('default');
    expect(env.decoderAddress).toBe(ABI_DECODER);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/explicit decoder\/registry overrides/);
  });

  // Bonus: rejects unknown profile values up front.
  it('rejects unknown POSTER_BATCH_PROFILE values', () => {
    expect(() =>
      parseEnv({ ...BASE_ENV, POSTER_BATCH_PROFILE: 'turbo' })
    ).toThrow(EnvConfigError);
    expect(() =>
      parseEnv({ ...BASE_ENV, POSTER_BATCH_PROFILE: 'turbo' })
    ).toThrow(/default \| canonical-registry \| canonical-full/);
  });
});
