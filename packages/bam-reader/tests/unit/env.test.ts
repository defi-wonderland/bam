import { describe, expect, it } from 'vitest';

import {
  EnvConfigError,
  assertChainIdMatches,
  parseEnv,
} from '../../src/bin/env.ts';
import { ChainIdMismatch } from '../../src/errors.js';

const VALID = {
  READER_CHAIN_ID: '11155111',
  READER_RPC_URL: 'https://rpc.example.test',
  READER_BAM_CORE: '0x000000000000000000000000000000000000c07e',
  READER_DB_URL: 'sqlite:./reader.db',
};

describe('parseEnv', () => {
  it('parses a minimal valid env', () => {
    const cfg = parseEnv({ ...VALID });
    expect(cfg.chainId).toBe(11155111);
    expect(cfg.rpcUrl).toBe('https://rpc.example.test');
    expect(cfg.bamCoreAddress).toBe('0x000000000000000000000000000000000000c07e');
    expect(cfg.dbUrl).toBe('sqlite:./reader.db');
    expect(cfg.httpBind).toBe('127.0.0.1');
    expect(cfg.httpPort).toBe(8788);
    expect(cfg.reorgWindowBlocks).toBe(32);
    expect(cfg.ethCallGasCap).toBe(50_000_000n);
    expect(cfg.ethCallTimeoutMs).toBe(5000);
    expect(cfg.beaconUrl).toBeUndefined();
    expect(cfg.blobscanUrl).toBeUndefined();
    expect(cfg.contentTags).toBeUndefined();
  });

  it('parses optional sources, content tags, and bounds', () => {
    const cfg = parseEnv({
      ...VALID,
      READER_BEACON_URL: 'https://beacon.example.test',
      READER_BLOBSCAN_URL: 'https://api.blobscan.test',
      READER_CONTENT_TAGS:
        '0x' + 'aa'.repeat(32) + ', 0x' + 'bb'.repeat(32),
      READER_REORG_WINDOW_BLOCKS: '64',
      READER_HTTP_BIND: '0.0.0.0',
      READER_HTTP_PORT: '9000',
      READER_ETH_CALL_GAS_CAP: '12345678',
      READER_ETH_CALL_TIMEOUT_MS: '750',
    });
    expect(cfg.beaconUrl).toBe('https://beacon.example.test');
    expect(cfg.blobscanUrl).toBe('https://api.blobscan.test');
    expect(cfg.contentTags?.length).toBe(2);
    expect(cfg.reorgWindowBlocks).toBe(64);
    expect(cfg.httpBind).toBe('0.0.0.0');
    expect(cfg.httpPort).toBe(9000);
    expect(cfg.ethCallGasCap).toBe(12_345_678n);
    expect(cfg.ethCallTimeoutMs).toBe(750);
  });

  it('throws EnvConfigError on missing required vars', () => {
    expect(() => parseEnv({})).toThrow(EnvConfigError);
    const partial = { ...VALID };
    delete (partial as Record<string, string>).READER_RPC_URL;
    expect(() => parseEnv(partial)).toThrow(/READER_RPC_URL/);
  });

  it('throws on a malformed BAM Core address', () => {
    expect(() =>
      parseEnv({ ...VALID, READER_BAM_CORE: '0xdeadbeef' })
    ).toThrow(/READER_BAM_CORE/);
  });

  it('throws on bad numeric values', () => {
    expect(() => parseEnv({ ...VALID, READER_CHAIN_ID: 'not-a-number' })).toThrow(
      EnvConfigError
    );
    expect(() => parseEnv({ ...VALID, READER_HTTP_PORT: '70000' })).toThrow(
      EnvConfigError
    );
    expect(() => parseEnv({ ...VALID, READER_ETH_CALL_GAS_CAP: '-1' })).toThrow(
      EnvConfigError
    );
  });

  it('rejects invalid content tags', () => {
    expect(() =>
      parseEnv({ ...VALID, READER_CONTENT_TAGS: '0xabc' })
    ).toThrow(/invalid bytes32/);
  });
});

describe('assertChainIdMatches', () => {
  it('does nothing when the observed and configured chain ids match', async () => {
    const client = { async getChainId() { return 1; } };
    await expect(assertChainIdMatches(client, 1)).resolves.toBeUndefined();
  });
  it('throws ChainIdMismatch when the observed chain id differs', async () => {
    const client = { async getChainId() { return 5; } };
    await expect(assertChainIdMatches(client, 1)).rejects.toBeInstanceOf(
      ChainIdMismatch
    );
  });
});
