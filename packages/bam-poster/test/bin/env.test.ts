import { describe, it, expect } from 'vitest';

import { EnvConfigError, parseEnv } from '../../src/bin/env.js';

const BASE = {
  POSTER_ALLOWED_TAGS: '0x' + 'aa'.repeat(32),
  POSTER_CHAIN_ID: '1',
  POSTER_BAM_CORE_ADDRESS: '0x9C4b230066a6808D83F5FBa0c040E0Df2Fcc7314',
  POSTER_RPC_URL: 'http://localhost:8545',
  POSTER_SIGNER_PRIVATE_KEY: '0x' + 'ab'.repeat(32),
};

describe('parseEnv', () => {
  it('parses a complete config', () => {
    const env = parseEnv(BASE);
    expect(env.chainId).toBe(1);
    expect(env.allowlistedTags).toHaveLength(1);
    expect(env.port).toBe(8787);
    expect(env.reorgWindowBlocks).toBe(32);
  });

  it('parses multiple tags from CSV', () => {
    const env = parseEnv({
      ...BASE,
      POSTER_ALLOWED_TAGS: `0x${'aa'.repeat(32)},0x${'bb'.repeat(32)}`,
    });
    expect(env.allowlistedTags).toHaveLength(2);
  });

  it('throws on missing signer', () => {
    const { POSTER_SIGNER_PRIVATE_KEY: _drop, ...rest } = BASE;
    expect(() => parseEnv(rest as NodeJS.ProcessEnv)).toThrow(EnvConfigError);
  });

  it('throws on malformed chain-id', () => {
    expect(() => parseEnv({ ...BASE, POSTER_CHAIN_ID: 'nope' })).toThrow(EnvConfigError);
  });

  it('throws on malformed bam-core address', () => {
    expect(() => parseEnv({ ...BASE, POSTER_BAM_CORE_ADDRESS: '0xdeadbeef' })).toThrow(
      EnvConfigError
    );
  });

  it('throws on a malformed tag', () => {
    expect(() =>
      parseEnv({ ...BASE, POSTER_ALLOWED_TAGS: `0x${'aa'.repeat(30)}` })
    ).toThrow(EnvConfigError);
  });

  it('canonicalizes mixed-case tags to lowercase (qodo review)', () => {
    // Hex casing isn't semantically meaningful, but store adapters
    // compare tags as case-sensitive TEXT — so the env boundary
    // must normalize to avoid stranding pending rows under one
    // casing while the worker queries for another.
    const env = parseEnv({
      ...BASE,
      POSTER_ALLOWED_TAGS: `0x${'AA'.repeat(32)},0x${'Bb'.repeat(32)}`,
    });
    expect(env.allowlistedTags).toEqual([
      `0x${'aa'.repeat(32)}`,
      `0x${'bb'.repeat(32)}`,
    ]);
  });

  it('clamps reorg window to [4, 128]', () => {
    expect(parseEnv({ ...BASE, POSTER_REORG_WINDOW_BLOCKS: '1' }).reorgWindowBlocks).toBe(4);
    expect(parseEnv({ ...BASE, POSTER_REORG_WINDOW_BLOCKS: '999' }).reorgWindowBlocks).toBe(128);
  });

  it('exposes POSTGRES_URL when set', () => {
    const env = parseEnv({
      ...BASE,
      POSTGRES_URL: 'postgres://x',
    });
    expect(env.postgresUrl).toBe('postgres://x');
  });

  it('defaults host to 127.0.0.1 and port to 8787', () => {
    const env = parseEnv(BASE);
    expect(env.host).toBe('127.0.0.1');
    expect(env.port).toBe(8787);
  });

  it('exposes POSTER_AUTH_TOKEN when set', () => {
    const env = parseEnv({ ...BASE, POSTER_AUTH_TOKEN: 'secret-xyz' });
    expect(env.authToken).toBe('secret-xyz');
  });

  it('leaves authToken undefined when POSTER_AUTH_TOKEN is absent or empty', () => {
    expect(parseEnv(BASE).authToken).toBeUndefined();
    expect(parseEnv({ ...BASE, POSTER_AUTH_TOKEN: '' }).authToken).toBeUndefined();
  });

  it('throws on invalid port', () => {
    expect(() => parseEnv({ ...BASE, POSTER_PORT: '-1' })).toThrow(EnvConfigError);
    expect(() => parseEnv({ ...BASE, POSTER_PORT: '99999' })).toThrow(EnvConfigError);
  });

  it('defaults POSTER_PACKING_LOSS_STREAK_WARN_THRESHOLD to 10', () => {
    expect(parseEnv(BASE).packingLossStreakWarnThreshold).toBe(10);
  });

  it('honors POSTER_PACKING_LOSS_STREAK_WARN_THRESHOLD when set', () => {
    expect(
      parseEnv({ ...BASE, POSTER_PACKING_LOSS_STREAK_WARN_THRESHOLD: '25' })
        .packingLossStreakWarnThreshold
    ).toBe(25);
  });

  it('throws on a non-positive POSTER_PACKING_LOSS_STREAK_WARN_THRESHOLD', () => {
    expect(() =>
      parseEnv({ ...BASE, POSTER_PACKING_LOSS_STREAK_WARN_THRESHOLD: '0' })
    ).toThrow(EnvConfigError);
    expect(() =>
      parseEnv({ ...BASE, POSTER_PACKING_LOSS_STREAK_WARN_THRESHOLD: '-1' })
    ).toThrow(EnvConfigError);
    expect(() =>
      parseEnv({ ...BASE, POSTER_PACKING_LOSS_STREAK_WARN_THRESHOLD: 'abc' })
    ).toThrow(EnvConfigError);
  });

  describe('POSTER_BATCH_ENCODING (feature 009)', () => {
    // Sepolia is the only chain with an ABIDecoder entry in the registry as
    // of this feature; chainId 1 is used for the fail-closed case.
    const SEPOLIA = { ...BASE, POSTER_CHAIN_ID: '11155111' };

    it('accepts "binary" and zeroes the decoder address (default branch)', () => {
      const env = parseEnv({ ...BASE, POSTER_BATCH_ENCODING: 'binary' });
      expect(env.batchEncoding).toBe('binary');
      expect(env.decoderAddress).toBe('0x0000000000000000000000000000000000000000');
    });

    it('defaults to "binary" when POSTER_BATCH_ENCODING is unset', () => {
      const env = parseEnv(BASE);
      expect(env.batchEncoding).toBe('binary');
      expect(env.decoderAddress).toBe('0x0000000000000000000000000000000000000000');
    });

    it('accepts "abi" and resolves decoderAddress from the deployments registry', () => {
      const env = parseEnv({ ...SEPOLIA, POSTER_BATCH_ENCODING: 'abi' });
      expect(env.batchEncoding).toBe('abi');
      // Address from packages/bam-contracts/deployments/11155111.json.
      expect(env.decoderAddress?.toLowerCase()).toBe(
        '0x3a1bb111079cbaf4cac320545bfd1f6a92250425'
      );
    });

    it('throws when "abi" is requested for a chainId without an ABIDecoder entry', () => {
      // chainId 1 (mainnet) has no ABIDecoder in the registry — fail closed.
      expect(() =>
        parseEnv({ ...BASE, POSTER_BATCH_ENCODING: 'abi' })
      ).toThrow(/ABIDecoder/);
    });

    it('rejects an empty string POSTER_BATCH_ENCODING (C-7)', () => {
      expect(() => parseEnv({ ...BASE, POSTER_BATCH_ENCODING: '' })).toThrow(EnvConfigError);
    });

    it('rejects case-mismatched "ABI" (no aliases)', () => {
      expect(() => parseEnv({ ...BASE, POSTER_BATCH_ENCODING: 'ABI' })).toThrow(EnvConfigError);
    });

    it('does not surface POSTER_DECODER_ADDRESS on ParsedEnv', () => {
      const env = parseEnv({
        ...BASE,
        POSTER_DECODER_ADDRESS: '0x1111111111111111111111111111111111111111',
      });
      // The field used to live on ParsedEnv; the new env contract drops it
      // entirely. The decoder address is now driven by batchEncoding +
      // registry resolution, not a hand-set env var.
      expect(Object.prototype.hasOwnProperty.call(env, 'decoderAddress')).toBe(true);
      expect(env.decoderAddress).toBe('0x0000000000000000000000000000000000000000');
    });
  });
});
