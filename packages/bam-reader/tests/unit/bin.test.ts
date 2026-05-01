/**
 * CLI tests for bam-reader.
 *
 * - argv parsing: serve / backfill subcommands, error paths
 * - SIGTERM graceful shutdown via subprocess
 * - backfill exit codes via subprocess
 *
 * The subprocess tests spawn the compiled CLI, so they require
 * `pnpm --filter bam-reader build` to have run; that's part of the
 * task's verification step.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  ArgParseError,
  jsonReplacer,
  lookupDeployBlock,
  parseArgs,
  resolveBackfillRange,
  resolveStartBlock,
  usage,
} from '../../src/bin/bam-reader.js';
import { UnknownChainDeploymentError } from '../../src/errors.js';
import type { ReaderConfig, ReaderEvent } from '../../src/types.js';

function baseCfg(over: Partial<ReaderConfig> = {}): ReaderConfig {
  return {
    chainId: 11155111,
    rpcUrl: 'https://rpc.example',
    bamCoreAddress: '0x000000000000000000000000000000000000c07e' as never,
    reorgWindowBlocks: 32,
    dbUrl: 'memory:',
    httpBind: '127.0.0.1',
    httpPort: 8788,
    ethCallGasCap: 50_000_000n,
    ethCallTimeoutMs: 5_000,
    logScanChunkBlocks: 2_000,
    backfillProgressIntervalMs: 10_000,
    backfillProgressEveryChunks: 5,
    ...over,
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('bam-reader CLI — argv parsing', () => {
  it('parses `serve` with no arguments', () => {
    expect(parseArgs(['serve'])).toEqual({ subcommand: 'serve' });
  });

  it('parses `backfill --from N --to M`', () => {
    expect(
      parseArgs(['backfill', '--from', '100', '--to', '200'])
    ).toEqual({ subcommand: 'backfill', fromMarker: 'block', fromBlock: 100, toBlock: 200 });
    // flag order is irrelevant
    expect(
      parseArgs(['backfill', '--to', '200', '--from', '100'])
    ).toEqual({ subcommand: 'backfill', fromMarker: 'block', fromBlock: 100, toBlock: 200 });
  });

  it('parses `backfill --from deploy` with no --to', () => {
    expect(parseArgs(['backfill', '--from', 'deploy'])).toEqual({
      subcommand: 'backfill',
      fromMarker: 'deploy',
      toBlock: undefined,
    });
  });

  it('parses `backfill --from deploy --to N`', () => {
    expect(parseArgs(['backfill', '--from', 'deploy', '--to', '8000000'])).toEqual({
      subcommand: 'backfill',
      fromMarker: 'deploy',
      toBlock: 8_000_000,
    });
  });

  it('rejects `backfill --from deploy --to notanumber`', () => {
    expect(() =>
      parseArgs(['backfill', '--from', 'deploy', '--to', 'notanumber'])
    ).toThrow(ArgParseError);
  });

  it('parses `backfill --catchup`', () => {
    expect(parseArgs(['backfill', '--catchup'])).toEqual({
      subcommand: 'backfill',
      fromMarker: 'catchup',
    });
  });

  it('rejects `--catchup` combined with --from', () => {
    expect(() => parseArgs(['backfill', '--catchup', '--from', '100'])).toThrow(
      /mutually exclusive/
    );
  });

  it('rejects `--catchup` combined with --to', () => {
    expect(() => parseArgs(['backfill', '--catchup', '--to', '100'])).toThrow(
      /mutually exclusive/
    );
  });

  it('throws ArgParseError on missing subcommand', () => {
    expect(() => parseArgs([])).toThrow(ArgParseError);
  });

  it('throws ArgParseError on unknown subcommand', () => {
    expect(() => parseArgs(['frobnicate'])).toThrow(/unknown subcommand/);
  });

  it('throws when serve is given extra args', () => {
    expect(() => parseArgs(['serve', '--from', '1'])).toThrow(/serve takes no arguments/);
  });

  it('throws when backfill --from N is missing --to', () => {
    expect(() => parseArgs(['backfill', '--from', '100'])).toThrow(/requires --from N --to M/);
  });

  it('throws when backfill is missing --from', () => {
    expect(() => parseArgs(['backfill', '--to', '100'])).toThrow(/requires/);
  });

  it('throws when --from > --to or values are non-integer', () => {
    expect(() =>
      parseArgs(['backfill', '--from', '200', '--to', '100'])
    ).toThrow(/non-negative integers/);
    expect(() =>
      parseArgs(['backfill', '--from', 'abc', '--to', '100'])
    ).toThrow(/non-negative integers/);
  });

  it('exposes a usage string covering both subcommands', () => {
    const u = usage();
    expect(u).toMatch(/serve/);
    expect(u).toMatch(/backfill/);
    expect(u).toMatch(/--from/);
    expect(u).toMatch(/--to/);
    expect(u).toMatch(/deploy/);
  });
});

describe('bam-reader CLI — lookupDeployBlock', () => {
  it('returns the BAM Core deploy block for a known chainId', () => {
    expect(lookupDeployBlock(11155111)).toBe(10_764_769);
  });

  it('throws UnknownChainDeploymentError on an unknown chainId', () => {
    expect(() => lookupDeployBlock(999_999)).toThrow(UnknownChainDeploymentError);
    expect(() => lookupDeployBlock(999_999)).toThrow(/--from <block>/);
  });
});

describe('bam-reader CLI — resolveBackfillRange', () => {
  const fakeL1 = (head: number) => ({
    async getBlockNumber() {
      return BigInt(head);
    },
  });

  it('passes through fromBlock/toBlock for fromMarker=block', async () => {
    const r = await resolveBackfillRange(
      { subcommand: 'backfill', fromMarker: 'block', fromBlock: 10, toBlock: 100 },
      baseCfg(),
      fakeL1(500)
    );
    expect(r).toEqual({ fromBlock: 10, toBlock: 100 });
  });

  it('defaults --from deploy toBlock to safe head (head - reorgWindowBlocks)', async () => {
    const r = await resolveBackfillRange(
      { subcommand: 'backfill', fromMarker: 'deploy', toBlock: undefined },
      baseCfg({ chainId: 11155111, reorgWindowBlocks: 32 }),
      fakeL1(11_500_000)
    );
    // Reorg safety: cursor must not advance past safeHead = 11_500_000 - 32.
    expect(r).toEqual({ fromBlock: 10_764_769, toBlock: 11_499_968 });
  });

  it('honors --to override under fromMarker=deploy (operator opt-in past safeHead)', async () => {
    const r = await resolveBackfillRange(
      { subcommand: 'backfill', fromMarker: 'deploy', toBlock: 11_000_000 },
      baseCfg({ chainId: 11155111 }),
      fakeL1(11_500_000)
    );
    expect(r).toEqual({ fromBlock: 10_764_769, toBlock: 11_000_000 });
  });

  it('rejects --from deploy --to N when N < deployBlock (inverted range)', async () => {
    await expect(
      resolveBackfillRange(
        { subcommand: 'backfill', fromMarker: 'deploy', toBlock: 1_000 },
        baseCfg({ chainId: 11155111 }),
        fakeL1(11_500_000)
      )
    ).rejects.toBeInstanceOf(ArgParseError);
    await expect(
      resolveBackfillRange(
        { subcommand: 'backfill', fromMarker: 'deploy', toBlock: 1_000 },
        baseCfg({ chainId: 11155111 }),
        fakeL1(11_500_000)
      )
    ).rejects.toThrow(/below deploy block 10764769/);
  });

  it('throws a chain-too-young error for --from deploy when head is within the reorg window', async () => {
    // Young chain: head=10, reorgWindowBlocks=32 → safeHead clamped to 0.
    // Sepolia deploy block (10_764_769) is unreachable; the error should
    // explicitly name the reorg-window cause rather than the generic
    // inverted-range message.
    await expect(
      resolveBackfillRange(
        { subcommand: 'backfill', fromMarker: 'deploy', toBlock: undefined },
        baseCfg({ chainId: 11155111, reorgWindowBlocks: 32 }),
        fakeL1(10)
      )
    ).rejects.toThrow(/within the reorg window/);
    await expect(
      resolveBackfillRange(
        { subcommand: 'backfill', fromMarker: 'deploy', toBlock: undefined },
        baseCfg({ chainId: 11155111, reorgWindowBlocks: 32 }),
        fakeL1(10)
      )
    ).rejects.toThrow(/safeHead=0/);
  });

  it('catchup on a young chain returns an empty (idempotent) range without throwing', async () => {
    // head=10, reorgWindowBlocks=32 → safeHead clamped to 0.
    // cursor=5 → fromBlock=6 > toBlock=0 → empty range. Backfill
    // empty-range early return turns this into a successful no-op
    // ("not enough chain depth yet"), which is the right thing here.
    const reader = {
      async cursorBlock() {
        return 5;
      },
    };
    const r = await resolveBackfillRange(
      { subcommand: 'backfill', fromMarker: 'catchup' },
      baseCfg({ chainId: 11155111, reorgWindowBlocks: 32 }),
      fakeL1(10),
      reader
    );
    expect(r.fromBlock).toBeGreaterThan(r.toBlock);
    expect(r.toBlock).toBeGreaterThanOrEqual(0); // safeHead never goes negative
  });

  it('throws UnknownChainDeploymentError when chainId is not in the table', async () => {
    await expect(
      resolveBackfillRange(
        { subcommand: 'backfill', fromMarker: 'deploy', toBlock: undefined },
        baseCfg({ chainId: 999_999 }),
        fakeL1(11_500_000)
      )
    ).rejects.toBeInstanceOf(UnknownChainDeploymentError);
  });

  it('resolves --catchup against a populated cursor as [cursor + 1, safe head]', async () => {
    const reader = {
      async cursorBlock() {
        return 1_000;
      },
    };
    const r = await resolveBackfillRange(
      { subcommand: 'backfill', fromMarker: 'catchup' },
      baseCfg({ chainId: 11155111, reorgWindowBlocks: 32 }),
      fakeL1(2_500),
      reader
    );
    // Reorg safety: cursor must not advance past safeHead = 2_500 - 32.
    expect(r).toEqual({ fromBlock: 1_001, toBlock: 2_468 });
  });

  it('--catchup with cursor already past safeHead returns an empty (idempotent) range', async () => {
    // safeHead = 2500 - 32 = 2468; cursor at 2470 means caught up.
    const reader = {
      async cursorBlock() {
        return 2_470;
      },
    };
    const r = await resolveBackfillRange(
      { subcommand: 'backfill', fromMarker: 'catchup' },
      baseCfg({ chainId: 11155111, reorgWindowBlocks: 32 }),
      fakeL1(2_500),
      reader
    );
    // fromBlock > toBlock — backfill's empty-range early return handles it.
    expect(r.fromBlock).toBeGreaterThan(r.toBlock);
  });

  it('rejects --catchup against an empty cursor with an ArgParseError naming alternatives', async () => {
    const reader = {
      async cursorBlock() {
        return null;
      },
    };
    await expect(
      resolveBackfillRange(
        { subcommand: 'backfill', fromMarker: 'catchup' },
        baseCfg({ chainId: 11155111 }),
        fakeL1(2_500),
        reader
      )
    ).rejects.toBeInstanceOf(ArgParseError);
  });
});

describe('bam-reader CLI — resolveStartBlock', () => {
  it('uses cfg.startBlock when set (env override always wins)', () => {
    const warn = vi.fn();
    const got = resolveStartBlock(baseCfg({ startBlock: 7_000_000 }), warn);
    expect(got).toBe(7_000_000);
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to the bam-sdk deploy table when env is unset', () => {
    const warn = vi.fn();
    const got = resolveStartBlock(baseCfg({ chainId: 11155111 }), warn);
    expect(got).toBe(10_764_769);
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to 0 with a loud warn when chainId is unknown', () => {
    const warn = vi.fn();
    const got = resolveStartBlock(baseCfg({ chainId: 999_999 }), warn);
    expect(got).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/999999|999_999/);
    expect(warn.mock.calls[0][0]).toMatch(/READER_START_BLOCK/);
  });
});

describe('bam-reader CLI — structured log replacer', () => {
  it('serializes message_conflict (the bigint-bearing event) without throwing', () => {
    // Regression guard: `ReaderEvent.message_conflict` carries
    // `nonce: bigint`. Without `jsonReplacer`, JSON.stringify throws
    // "Do not know how to serialize a BigInt" synchronously, the
    // throw escapes the logger callback inside withTxn, the txn
    // rolls back, and the live-tail tick reports
    // `live_tail_tick_failed` instead of the actual conflict.
    const event: ReaderEvent = {
      kind: 'message_conflict',
      txHash: ('0x' + '11'.repeat(32)) as never,
      messageHash: ('0x' + '22'.repeat(32)) as never,
      author: ('0x' + '33'.repeat(20)) as never,
      nonce: 42n,
    };
    expect(() => JSON.stringify(event, jsonReplacer)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(event, jsonReplacer));
    expect(parsed.nonce).toBe('42');
    expect(parsed.kind).toBe('message_conflict');
  });

  it('passes non-bigint values through unchanged', () => {
    const event: ReaderEvent = {
      kind: 'message_verified',
      txHash: ('0x' + '11'.repeat(32)) as never,
      messageHash: ('0x' + '22'.repeat(32)) as never,
    };
    const parsed = JSON.parse(JSON.stringify(event, jsonReplacer));
    expect(parsed).toEqual(event);
  });
});

describe('bam-reader CLI — subprocess', () => {
  const binPath = path.resolve(
    __dirname,
    '../../dist/esm/bin/bam-reader.js'
  );

  function ensureBuilt(): void {
    if (!existsSync(binPath)) {
      throw new Error(
        `subprocess test requires the build output at ${binPath}. Run \`pnpm --filter bam-reader build\` first.`
      );
    }
  }

  function spawnReader(
    argv: string[],
    env: NodeJS.ProcessEnv,
    cwd: string
  ): import('node:child_process').ChildProcessWithoutNullStreams {
    return spawn(process.execPath, [binPath, ...argv], {
      env: { ...process.env, ...env, NODE_ENV: 'test' },
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  async function startMockRpc(opts: { chainId: number }): Promise<{
    url: string;
    close: () => Promise<void>;
  }> {
    const server = createServer((req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.end();
        return;
      }
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { id: number; method: string; params?: unknown[] };
        let result: unknown = null;
        switch (parsed.method) {
          case 'eth_chainId':
            result = '0x' + opts.chainId.toString(16);
            break;
          case 'eth_blockNumber':
            result = '0x' + (1000).toString(16);
            break;
          case 'eth_getLogs':
            result = [];
            break;
          default:
            result = null;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('rpc not bound');
    return {
      url: `http://127.0.0.1:${addr.port}`,
      async close() {
        await new Promise<void>((r) => server.close(() => r()));
      },
    };
  }

  function readerEnv(rpcUrl: string, _dbPath: string, chainId = 1): Record<string, string> {
    return {
      READER_CHAIN_ID: String(chainId),
      READER_RPC_URL: rpcUrl,
      READER_BAM_CORE: '0x000000000000000000000000000000000000c07e',
      // In-process PGLite — the CLI no longer accepts sqlite: URLs.
      // The dbPath argument is kept for callers that still mkdtemp,
      // but is unused.
      READER_DB_URL: 'memory:',
      READER_HTTP_BIND: '127.0.0.1',
      READER_HTTP_PORT: '0',
    };
  }

  it('exits 0 on SIGTERM during serve and prints "shutting down"', async () => {
    ensureBuilt();
    const rpc = await startMockRpc({ chainId: 1 });
    const dir = mkdtempSync(path.join(tmpdir(), 'bam-reader-bin-'));
    const dbPath = path.join(dir, 'reader.db');
    try {
      const child = spawnReader(['serve'], readerEnv(rpc.url, dbPath, 1), dir);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (b: Buffer) => (stdout += b.toString()));
      child.stderr.on('data', (b: Buffer) => (stderr += b.toString()));

      // Wait for the listening line so we know the process is up.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timeout waiting for listening line; stderr: ${stderr}`)),
          15_000
        );
        const onData = (b: Buffer) => {
          stdout += b.toString();
          if (stdout.includes('listening on')) {
            clearTimeout(timer);
            child.stdout.off('data', onData);
            resolve();
          }
        };
        child.stdout.on('data', onData);
      });

      // Brief wait so the serve loop's first iteration is in flight
      // (or already past) when SIGTERM arrives.
      await new Promise((r) => setTimeout(r, 100));
      child.kill('SIGTERM');
      const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          child.once('exit', (c, s) => resolve({ code: c, signal: s }));
        }
      );
      if (exitInfo.code !== 0) {
        throw new Error(
          `expected exit 0, got code=${exitInfo.code} signal=${exitInfo.signal}\n` +
            `stdout: ${stdout}\nstderr: ${stderr}`
        );
      }
      expect(stdout).toMatch(/shutting down/);
    } finally {
      await rpc.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('backfill exits 0 on success', async () => {
    ensureBuilt();
    const rpc = await startMockRpc({ chainId: 1 });
    const dir = mkdtempSync(path.join(tmpdir(), 'bam-reader-bf-'));
    const dbPath = path.join(dir, 'reader.db');
    try {
      const child = spawnReader(
        ['backfill', '--from', '0', '--to', '10'],
        readerEnv(rpc.url, dbPath, 1),
        dir
      );
      const code = await new Promise<number>((resolve) => {
        child.once('exit', (c) => resolve(c ?? -1));
      });
      expect(code).toBe(0);
    } finally {
      await rpc.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it('backfill exits non-zero on a chain-id mismatch', async () => {
    ensureBuilt();
    // mock RPC reports chain id 5; env declares 1 → ChainIdMismatch → exit 3.
    const rpc = await startMockRpc({ chainId: 5 });
    const dir = mkdtempSync(path.join(tmpdir(), 'bam-reader-mismatch-'));
    const dbPath = path.join(dir, 'reader.db');
    try {
      const child = spawnReader(
        ['backfill', '--from', '0', '--to', '10'],
        readerEnv(rpc.url, dbPath, 1),
        dir
      );
      let stderr = '';
      child.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
      const code = await new Promise<number>((resolve) => {
        child.once('exit', (c) => resolve(c ?? -1));
      });
      expect(code).toBe(3);
      expect(stderr).toMatch(/chain id/i);
    } finally {
      await rpc.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
