import { describe, expect, it } from 'vitest';

import { parseEnv, EnvConfigError } from '../../src/bin/env.js';

const REQUIRED = {
  INDEXER_CHAIN_ID: '11155111',
  INDEXER_DB_URL: 'postgres://x:y@localhost/z',
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

  it('requires INDEXER_CHAIN_ID and INDEXER_DB_URL', () => {
    expect(() => parseEnv({ INDEXER_DB_URL: 'postgres://x' })).toThrow(EnvConfigError);
    expect(() => parseEnv({ INDEXER_CHAIN_ID: '1' })).toThrow(EnvConfigError);
  });
});
