import { describe, expect, it, vi } from 'vitest';

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
  READER_DB_URL: 'postgres://example.test/bam',
};

describe('parseEnv', () => {
  it('parses a minimal valid env', () => {
    const cfg = parseEnv({ ...VALID });
    expect(cfg.chainId).toBe(11155111);
    expect(cfg.rpcUrl).toBe('https://rpc.example.test');
    expect(cfg.bamCoreAddress).toBe('0x000000000000000000000000000000000000c07e');
    expect(cfg.dbUrl).toBe('postgres://example.test/bam');
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

  describe('reader scan ergonomics knobs', () => {
    it('defaults the scan-ergonomics knobs when env is silent', () => {
      const cfg = parseEnv({ ...VALID });
      expect(cfg.startBlock).toBeUndefined();
      expect(cfg.logScanChunkBlocks).toBe(2_000);
      expect(cfg.backfillProgressIntervalMs).toBe(10_000);
      expect(cfg.backfillProgressEveryChunks).toBe(5);
    });

    it('reads READER_START_BLOCK as a non-negative integer', () => {
      const cfg = parseEnv({ ...VALID, READER_START_BLOCK: '1234567' });
      expect(cfg.startBlock).toBe(1_234_567);
    });

    it('rejects READER_START_BLOCK below 0', () => {
      expect(() =>
        parseEnv({ ...VALID, READER_START_BLOCK: '-1' })
      ).toThrow(/READER_START_BLOCK/);
    });

    it('rejects READER_LOG_SCAN_CHUNK_BLOCKS outside [64, 100_000]', () => {
      expect(() =>
        parseEnv({ ...VALID, READER_LOG_SCAN_CHUNK_BLOCKS: '63' })
      ).toThrow(/READER_LOG_SCAN_CHUNK_BLOCKS/);
      expect(() =>
        parseEnv({ ...VALID, READER_LOG_SCAN_CHUNK_BLOCKS: '100001' })
      ).toThrow(/READER_LOG_SCAN_CHUNK_BLOCKS/);
    });

    it('reads READER_LOG_SCAN_CHUNK_BLOCKS at the bounds', () => {
      expect(parseEnv({ ...VALID, READER_LOG_SCAN_CHUNK_BLOCKS: '64' }).logScanChunkBlocks).toBe(64);
      expect(
        parseEnv({ ...VALID, READER_LOG_SCAN_CHUNK_BLOCKS: '100000' }).logScanChunkBlocks
      ).toBe(100_000);
    });

    it('rejects READER_BACKFILL_PROGRESS_INTERVAL_MS < 1', () => {
      expect(() =>
        parseEnv({ ...VALID, READER_BACKFILL_PROGRESS_INTERVAL_MS: '0' })
      ).toThrow(/READER_BACKFILL_PROGRESS_INTERVAL_MS/);
    });

    it('rejects READER_BACKFILL_PROGRESS_EVERY_CHUNKS < 1', () => {
      expect(() =>
        parseEnv({ ...VALID, READER_BACKFILL_PROGRESS_EVERY_CHUNKS: '0' })
      ).toThrow(/READER_BACKFILL_PROGRESS_EVERY_CHUNKS/);
    });

    it('reads non-default values for all four knobs', () => {
      const cfg = parseEnv({
        ...VALID,
        READER_START_BLOCK: '7800000',
        READER_LOG_SCAN_CHUNK_BLOCKS: '500',
        READER_BACKFILL_PROGRESS_INTERVAL_MS: '2500',
        READER_BACKFILL_PROGRESS_EVERY_CHUNKS: '3',
      });
      expect(cfg.startBlock).toBe(7_800_000);
      expect(cfg.logScanChunkBlocks).toBe(500);
      expect(cfg.backfillProgressIntervalMs).toBe(2_500);
      expect(cfg.backfillProgressEveryChunks).toBe(3);
    });
  });

  describe('dbUrl resolution', () => {
    function withoutDbUrl(over: Record<string, string> = {}): NodeJS.ProcessEnv {
      const partial: Record<string, string> = { ...VALID, ...over };
      delete partial.READER_DB_URL;
      return partial;
    }

    it('uses READER_DB_URL when set; never warns', () => {
      const warn = vi.fn();
      const cfg = parseEnv(VALID, warn);
      expect(cfg.dbUrl).toBe('postgres://example.test/bam');
      expect(warn).not.toHaveBeenCalled();
    });

    it('falls back to POSTGRES_URL when READER_DB_URL is unset', () => {
      const warn = vi.fn();
      const cfg = parseEnv(
        withoutDbUrl({ POSTGRES_URL: 'postgres://example/bam' }),
        warn
      );
      expect(cfg.dbUrl).toBe('postgres://example/bam');
      expect(warn).not.toHaveBeenCalled();
    });

    it('READER_DB_URL takes precedence over POSTGRES_URL when both are set', () => {
      const cfg = parseEnv({
        ...VALID,
        POSTGRES_URL: 'postgres://example/bam',
      });
      expect(cfg.dbUrl).toBe('postgres://example.test/bam');
    });

    it('defaults to memory: and emits a warning when neither is set', () => {
      const warn = vi.fn();
      const cfg = parseEnv(withoutDbUrl(), warn);
      expect(cfg.dbUrl).toBe('memory:');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/non-durable/i);
    });

    it('treats empty-string env values as unset for the fallback chain', () => {
      // dotenv users sometimes write `POSTGRES_URL=` to "blank out" a
      // value; the optionalString helper already collapses '' to
      // undefined, but make the contract explicit.
      const warn = vi.fn();
      const cfg = parseEnv(
        { ...withoutDbUrl(), POSTGRES_URL: '' },
        warn
      );
      expect(cfg.dbUrl).toBe('memory:');
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('accepts the bare "memory" form (no trailing colon)', () => {
      const cfg = parseEnv({ ...withoutDbUrl(), READER_DB_URL: 'memory' });
      expect(cfg.dbUrl).toBe('memory');
    });

    it('accepts a postgresql:// prefix as well as postgres://', () => {
      const cfg = parseEnv({
        ...withoutDbUrl(),
        READER_DB_URL: 'postgresql://example/bam',
      });
      expect(cfg.dbUrl).toBe('postgresql://example/bam');
    });

    it('rejects an unsupported scheme on READER_DB_URL with EnvConfigError', () => {
      // Pre-feature-007 a bad scheme would throw a generic Error from
      // the store factory at construction time; promote to
      // EnvConfigError so the CLI exits with the documented config-
      // error code and a clear message.
      expect(() =>
        parseEnv({ ...withoutDbUrl(), READER_DB_URL: 'sqlite:./reader.db' })
      ).toThrow(EnvConfigError);
      expect(() =>
        parseEnv({ ...withoutDbUrl(), READER_DB_URL: 'sqlite:./reader.db' })
      ).toThrow(/READER_DB_URL has unsupported DSN scheme "sqlite"/);
    });

    it('rejects an unsupported scheme on POSTGRES_URL and names POSTGRES_URL as the source', () => {
      // qodo PR #29: when the value comes from POSTGRES_URL but the
      // error message says "READER_DB_URL", the operator looks in the
      // wrong env var. Source attribution must follow the resolution
      // chain.
      expect(() =>
        parseEnv({ ...withoutDbUrl(), POSTGRES_URL: 'mysql://example/bam' })
      ).toThrow(/POSTGRES_URL has unsupported DSN scheme "mysql"/);
    });

    it('does not leak DSN credentials in the error message (qodo PR #29 follow-up)', () => {
      // A misconfigured DSN must not echo embedded credentials to
      // stderr/logs. The error names the source env var and the
      // scheme; the userinfo, host, path, and query are dropped.
      const leakyDsn = 'mysql://admin:hunter2@db.internal:3306/bam';
      let caught: unknown = null;
      try {
        parseEnv({ ...withoutDbUrl(), POSTGRES_URL: leakyDsn });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(EnvConfigError);
      const msg = (caught as Error).message;
      expect(msg).toContain('POSTGRES_URL');
      expect(msg).toContain('mysql');
      expect(msg).not.toContain('hunter2');
      expect(msg).not.toContain('admin');
      expect(msg).not.toContain('db.internal');
    });

    it('handles a value with no colon at all without echoing it', () => {
      // If an operator accidentally pastes a bare secret into
      // POSTGRES_URL (no scheme), the error must not echo the value.
      const bareSecret = 'pleasedontleakthisstring';
      let caught: unknown = null;
      try {
        parseEnv({ ...withoutDbUrl(), POSTGRES_URL: bareSecret });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(EnvConfigError);
      expect((caught as Error).message).not.toContain(bareSecret);
      expect((caught as Error).message).toContain('(no scheme)');
    });
  });

  describe('chain id cross-check against POSTER_CHAIN_ID', () => {
    it('passes when both are present and match', () => {
      const cfg = parseEnv({ ...VALID, POSTER_CHAIN_ID: '11155111' });
      expect(cfg.chainId).toBe(11155111);
    });

    it('throws when both are present and differ', () => {
      expect(() =>
        parseEnv({ ...VALID, POSTER_CHAIN_ID: '1' })
      ).toThrow(/READER_CHAIN_ID=11155111 does not match POSTER_CHAIN_ID=1/);
    });

    it('is silent when POSTER_CHAIN_ID is unset', () => {
      const cfg = parseEnv(VALID);
      expect(cfg.chainId).toBe(11155111);
    });

    it('rejects a malformed POSTER_CHAIN_ID rather than silently ignoring it', () => {
      expect(() =>
        parseEnv({ ...VALID, POSTER_CHAIN_ID: 'not-a-number' })
      ).toThrow(/POSTER_CHAIN_ID/);
    });
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
