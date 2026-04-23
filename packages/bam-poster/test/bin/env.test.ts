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

  it('clamps reorg window to [4, 128]', () => {
    expect(parseEnv({ ...BASE, POSTER_REORG_WINDOW_BLOCKS: '1' }).reorgWindowBlocks).toBe(4);
    expect(parseEnv({ ...BASE, POSTER_REORG_WINDOW_BLOCKS: '999' }).reorgWindowBlocks).toBe(128);
  });

  it('exposes POSTGRES_URL and POSTER_SQLITE_PATH if set', () => {
    const env = parseEnv({
      ...BASE,
      POSTGRES_URL: 'postgres://x',
      POSTER_SQLITE_PATH: '/tmp/x.db',
    });
    expect(env.postgresUrl).toBe('postgres://x');
    expect(env.sqlitePath).toBe('/tmp/x.db');
  });

  it('defaults host to 127.0.0.1 and port to 8787', () => {
    const env = parseEnv(BASE);
    expect(env.host).toBe('127.0.0.1');
    expect(env.port).toBe(8787);
  });

  it('exposes POSTER_AUTH_TOKEN when set (FU-12)', () => {
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
});
