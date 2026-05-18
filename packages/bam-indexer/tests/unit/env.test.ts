import { describe, expect, it } from 'vitest';

import { parseEnv, EnvConfigError } from '../../src/bin/env.js';

const VALID_TAG = '0x' + 'f0'.repeat(32);

const REQUIRED = {
  INDEXER_CHAIN_ID: '11155111',
  INDEXER_DB_URL: 'postgres://x:y@localhost/z',
  INDEXER_TWITTER_TAG: VALID_TAG,
};

describe('parseEnv', () => {
  it('applies defaults when only the required vars are set', () => {
    const cfg = parseEnv({ ...REQUIRED });
    expect(cfg.pollMs).toBe(5000);
    expect(cfg.batchSize).toBe(200);
    expect(cfg.httpBind).toBe('127.0.0.1');
    expect(cfg.httpPort).toBe(8789);
  });

  it('rejects INDEXER_POLL_MS=0 (would spin the serve loop)', () => {
    expect(() => parseEnv({ ...REQUIRED, INDEXER_POLL_MS: '0' })).toThrow(EnvConfigError);
  });

  it('rejects INDEXER_BATCH_SIZE=0 (would wedge forward progress)', () => {
    expect(() => parseEnv({ ...REQUIRED, INDEXER_BATCH_SIZE: '0' })).toThrow(EnvConfigError);
  });

  it('accepts INDEXER_HTTP_PORT=0 (OS-assigned port is a valid config)', () => {
    const cfg = parseEnv({ ...REQUIRED, INDEXER_HTTP_PORT: '0' });
    expect(cfg.httpPort).toBe(0);
  });

  it('rejects non-numeric values', () => {
    expect(() => parseEnv({ ...REQUIRED, INDEXER_POLL_MS: 'abc' })).toThrow(EnvConfigError);
    expect(() => parseEnv({ ...REQUIRED, INDEXER_BATCH_SIZE: '-1' })).toThrow(EnvConfigError);
  });

  it('requires INDEXER_CHAIN_ID, INDEXER_DB_URL, INDEXER_TWITTER_TAG', () => {
    const { INDEXER_CHAIN_ID, INDEXER_DB_URL, INDEXER_TWITTER_TAG, ...rest } = REQUIRED;
    expect(() => parseEnv({ ...rest, INDEXER_DB_URL, INDEXER_TWITTER_TAG })).toThrow(/INDEXER_CHAIN_ID/);
    expect(() => parseEnv({ ...rest, INDEXER_CHAIN_ID, INDEXER_TWITTER_TAG })).toThrow(/INDEXER_DB_URL/);
    expect(() => parseEnv({ ...rest, INDEXER_CHAIN_ID, INDEXER_DB_URL })).toThrow(/INDEXER_TWITTER_TAG/);
  });

  it('rejects INDEXER_TWITTER_TAG that is not a 32-byte 0x-hex string', () => {
    expect(() => parseEnv({ ...REQUIRED, INDEXER_TWITTER_TAG: '0xabc' })).toThrow(/INDEXER_TWITTER_TAG/);
    expect(() => parseEnv({ ...REQUIRED, INDEXER_TWITTER_TAG: 'f0'.repeat(32) })).toThrow(/INDEXER_TWITTER_TAG/);
    expect(() => parseEnv({ ...REQUIRED, INDEXER_TWITTER_TAG: '0x' + 'zz'.repeat(32) })).toThrow(/INDEXER_TWITTER_TAG/);
  });

  it('lowercases the parsed tag', () => {
    const cfg = parseEnv({ ...REQUIRED, INDEXER_TWITTER_TAG: '0x' + 'F0'.repeat(32) });
    expect(cfg.twitterTag).toBe('0x' + 'f0'.repeat(32));
  });
});
