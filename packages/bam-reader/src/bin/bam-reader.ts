#!/usr/bin/env node
/**
 * `bam-reader` CLI entrypoint. Two subcommands:
 *
 *   - `serve`               — long-running daemon. Live-tails the
 *                             configured chain, mounts `/health` on
 *                             `READER_HTTP_BIND:READER_HTTP_PORT`,
 *                             runs until SIGINT/SIGTERM.
 *   - `backfill --from N --to M` — one-shot historical run; exits 0
 *                                  on success.
 *
 * Exit codes:
 *   0 — graceful shutdown / backfill success
 *   1 — uncaught error
 *   2 — env config error
 *   3 — startup chain-id mismatch
 *   4 — bad subcommand / argv parse error
 */

import { ChainIdMismatch } from '../errors.js';
import { EnvConfigError, parseEnv } from './env.js';
import { createReader } from '../factory.js';
import { ReaderHttpServer } from '../http/server.js';
import { createViemL1 } from './viem-l1.js';

export interface ParsedArgs {
  subcommand: 'serve' | 'backfill';
  fromBlock?: number;
  toBlock?: number;
}

export class ArgParseError extends Error {
  readonly code = 'arg_parse_error';
}

/**
 * Parse argv into a subcommand + options. Strict — no positional
 * defaults, no implicit subcommand. The first arg must be `serve` or
 * `backfill`; backfill requires `--from N --to M`.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) {
    throw new ArgParseError('expected subcommand: serve | backfill');
  }
  const sub = argv[0];
  if (sub === '--help' || sub === '-h') {
    throw new ArgParseError(usage());
  }
  if (sub !== 'serve' && sub !== 'backfill') {
    throw new ArgParseError(`unknown subcommand: ${sub}`);
  }
  if (sub === 'serve') {
    if (argv.length > 1) {
      throw new ArgParseError(`serve takes no arguments (got ${argv.slice(1).join(' ')})`);
    }
    return { subcommand: 'serve' };
  }
  // backfill --from N --to M
  let from: number | undefined;
  let to: number | undefined;
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--from') {
      if (next === undefined) throw new ArgParseError('--from requires a block number');
      from = Number(next);
      i += 1;
    } else if (flag === '--to') {
      if (next === undefined) throw new ArgParseError('--to requires a block number');
      to = Number(next);
      i += 1;
    } else {
      throw new ArgParseError(`unknown flag: ${flag}`);
    }
  }
  if (from === undefined || to === undefined) {
    throw new ArgParseError('backfill requires --from N --to M');
  }
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
    throw new ArgParseError('--from and --to must be non-negative integers with from ≤ to');
  }
  return { subcommand: 'backfill', fromBlock: from, toBlock: to };
}

export function usage(): string {
  return [
    'usage:',
    '  bam-reader serve',
    '  bam-reader backfill --from <block> --to <block>',
  ].join('\n');
}

export async function runCli(
  argv: string[] = process.argv.slice(2)
): Promise<void> {
  // Surface --help / -h before env parsing so users without env see usage.
  if (argv.length > 0 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`bam-reader: ${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write(`${usage()}\n`);
    process.exit(4);
  }

  let cfg;
  try {
    cfg = parseEnv();
  } catch (err) {
    if (err instanceof EnvConfigError) {
      process.stderr.write(`bam-reader: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  const adapter = createViemL1(cfg.rpcUrl);

  let reader;
  try {
    reader = await createReader(cfg, {
      l1: adapter.l1,
      decodePublicClient: adapter.decodePublicClient,
      verifyPublicClient: adapter.verifyPublicClient,
      logger: (event) => {
        process.stdout.write(`[bam-reader] ${JSON.stringify(event)}\n`);
      },
    });
  } catch (err) {
    if (err instanceof ChainIdMismatch) {
      process.stderr.write(`bam-reader: ${err.message}\n`);
      process.exit(3);
    }
    throw err;
  }

  if (args.subcommand === 'backfill') {
    try {
      const result = await reader.backfill(args.fromBlock!, args.toBlock!);
      process.stdout.write(
        `[bam-reader] backfill complete: ${JSON.stringify(result)}\n`
      );
      await reader.close();
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `bam-reader: backfill failed: ${err instanceof Error ? err.message : String(err)}\n`
      );
      try {
        await reader.close();
      } catch {
        /* ignore */
      }
      process.exit(1);
    }
  }

  // serve
  const http = await ReaderHttpServer.start({
    reader,
    host: cfg.httpBind,
    port: cfg.httpPort,
  });
  process.stdout.write(
    `bam-reader listening on ${http.hostname()}:${http.port()}\n`
  );

  const serving = reader.serve();

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`bam-reader received ${signal}, shutting down\n`);
    try {
      await http.close();
      await reader.close();
      await serving;
      await adapter.close();
      process.exit(0);
    } catch {
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const isMain = (() => {
  try {
    // pnpm's workspace bin shim invokes the script via a symlink under
    // `<package>/node_modules/<package>/dist/...`. `import.meta.url`
    // resolves to the canonical (un-symlinked) path; `process.argv[1]`
    // is the symlinked path. Compare real paths so the entrypoint
    // check fires under both direct and via-bin invocations.
    return (
      fileURLToPath(import.meta.url) ===
      realpathSync(process.argv[1] ?? '')
    );
  } catch {
    return false;
  }
})();

if (isMain) {
  runCli().catch((err) => {
    process.stderr.write(
      `bam-reader: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  });
}
