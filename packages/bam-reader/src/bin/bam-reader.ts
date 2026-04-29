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

import { existsSync } from 'node:fs';
import path from 'node:path';
import { config as dotenvConfig } from 'dotenv';

import { getDeployment } from 'bam-sdk';

import { ChainIdMismatch, UnknownChainDeploymentError } from '../errors.js';
import { EnvConfigError, parseEnv } from './env.js';
import { createReader, type Reader } from '../factory.js';
import { ReaderHttpServer } from '../http/server.js';
import type { LiveTailL1Client } from '../loop/live-tail.js';
import type { ReaderConfig } from '../types.js';
import { createViemL1 } from './viem-l1.js';

/**
 * Resolve the live-tail's first-tick block for `cfg`:
 *   1. `cfg.startBlock` (env-set) — operator override always wins.
 *   2. `bam-sdk` deploy table for `cfg.chainId`'s BAM Core deploy block.
 *   3. `0` with a stderr warning naming the chainId and pointing at
 *      `READER_START_BLOCK`. Keeps anvil/hardhat zero-config; loud
 *      enough that "I'm on a real chain without the table populated"
 *      is impossible to miss.
 */
export function resolveStartBlock(
  cfg: ReaderConfig,
  warn: (msg: string) => void
): number {
  if (cfg.startBlock !== undefined) return cfg.startBlock;
  const fromTable = getDeployment(cfg.chainId)?.contracts
    .BlobAuthenticatedMessagingCore?.deployBlock;
  if (fromTable !== undefined) return fromTable;
  warn(
    `bam-reader: no deploy block known for chainId ${cfg.chainId}; ` +
      `defaulting startBlock to 0. Set READER_START_BLOCK to override.`
  );
  return 0;
}

/**
 * Resolve + load a dotenv file so users don't have to `export` each
 * READER_* var before running. Mirrors the Poster's `loadDotenv` —
 * resolution order:
 *   1. `READER_ENV_FILE` — explicit override (e.g.
 *      `READER_ENV_FILE=.env.sepolia pnpm dev:reader`).
 *   2. Walk up (bounded at 5 ancestors) looking for `.env.local`,
 *      then `.env`, in each directory. `.env.local` wins within a
 *      directory — same convention as the Poster + Next.js + Vite,
 *      so a single workspace `.env.local` feeds both backend
 *      services.
 *
 * Existing `process.env` values always win — dotenv only fills in
 * variables that aren't already set, matching standard semantics.
 */
function loadDotenv(): void {
  const explicit = process.env.READER_ENV_FILE;
  if (explicit !== undefined && explicit !== '') {
    if (existsSync(explicit)) dotenvConfig({ path: explicit });
    return;
  }
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    for (const name of ['.env.local', '.env']) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) {
        dotenvConfig({ path: candidate });
        return;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

/**
 * Look up the BAM Core deploy block for `chainId` from the bam-sdk
 * deploy table. Throws `UnknownChainDeploymentError` when the chainId
 * isn't in the table — the bin maps this to exit code 4 with a
 * message naming the explicit `--from N` form.
 */
export function lookupDeployBlock(chainId: number): number {
  const block = getDeployment(chainId)?.contracts
    .BlobAuthenticatedMessagingCore?.deployBlock;
  if (block === undefined) {
    throw new UnknownChainDeploymentError(
      `no deploy block known for chainId ${chainId}; pass an explicit ` +
        `--from <block> --to <block> instead`
    );
  }
  return block;
}

/**
 * Resolve a `backfill` ParsedArgs into concrete `[fromBlock, toBlock]`
 * bounds. Shared between `--from deploy` (T010) and `--catchup` (T012).
 *
 * Reorg safety: when `--to` is omitted, both `deploy` and `catchup`
 * default to `safeHead = head - reorgWindowBlocks` rather than `head`.
 * Advancing the cursor past `safeHead` would let a reorg within the
 * window land new `BlobBatchRegistered` logs that live-tail (which
 * resumes at `cursor + 1`) would never re-scan. Operators can still
 * pass an explicit `--to N` past `safeHead` — that's an opt-in.
 *
 * Throws `UnknownChainDeploymentError` on `--from deploy` against an
 * unknown chainId. Throws `ArgParseError` when an explicit `--to N`
 * for `--from deploy` is below the resolved deploy block (an inverted
 * range that would silently no-op). The bin maps both to exit 4.
 */
export async function resolveBackfillRange(
  args: ParsedArgs & { subcommand: 'backfill' },
  cfg: ReaderConfig,
  l1: Pick<LiveTailL1Client, 'getBlockNumber'>,
  reader?: Pick<Reader, 'cursorBlock'>
): Promise<{ fromBlock: number; toBlock: number }> {
  if (args.fromMarker === 'block') {
    return { fromBlock: args.fromBlock!, toBlock: args.toBlock! };
  }
  if (args.fromMarker === 'deploy') {
    const fromBlock = lookupDeployBlock(cfg.chainId);
    const head = Number(await l1.getBlockNumber());
    const safeHead = head - cfg.reorgWindowBlocks;
    const toBlock = args.toBlock !== undefined ? args.toBlock : safeHead;
    if (toBlock < fromBlock) {
      const source = args.toBlock !== undefined ? `--to ${args.toBlock}` : `safe head ${safeHead}`;
      throw new ArgParseError(
        `backfill --from deploy: resolved fromBlock=${fromBlock} but toBlock=${toBlock} ` +
          `(${source}); pass --to <block> >= ${fromBlock}`
      );
    }
    return { fromBlock, toBlock };
  }
  if (args.fromMarker === 'catchup') {
    if (reader === undefined) {
      throw new Error('catchup resolver needs a Reader handle');
    }
    const cursor = await reader.cursorBlock();
    if (cursor === null) {
      throw new ArgParseError(
        '--catchup requested but no cursor row exists yet; run ' +
          '`backfill --from <block> --to <block>` or ' +
          '`backfill --from deploy` first'
      );
    }
    const head = Number(await l1.getBlockNumber());
    const safeHead = head - cfg.reorgWindowBlocks;
    return { fromBlock: cursor + 1, toBlock: safeHead };
  }
  // Exhaustiveness guard.
  const _exhaustive: never = args.fromMarker;
  throw new Error(`unhandled fromMarker: ${String(_exhaustive)}`);
}

export type ParsedArgs =
  | { subcommand: 'serve' }
  | {
      subcommand: 'backfill';
      /**
       * `'block'` — operator passed `--from N --to M` (both required).
       * `'deploy'` — operator passed `--from deploy [--to N]` (resolved
       *   at runtime against the bam-sdk deploy table).
       * `'catchup'` — operator passed `--catchup` (resolved against the
       *   stored cursor; `[cursor + 1, head]`). Mutually exclusive with
       *   `--from` and `--to`.
       */
      fromMarker: 'block' | 'deploy' | 'catchup';
      /** Set when `fromMarker === 'block'`. */
      fromBlock?: number;
      /** Set when `fromMarker === 'block'` or operator override under `'deploy'`. */
      toBlock?: number;
    };

/**
 * `JSON.stringify` replacer that stringifies bigints to decimal.
 * `ReaderEvent.message_conflict` carries `nonce: bigint` and at least
 * one structured-log call site emits it from inside a withTxn —
 * without a replacer, the throw kills the live-tail tick instead of
 * surfacing the conflict. Same convention as
 * `http/routes.ts:jsonResponse`.
 */
export function jsonReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
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
  // backfill --from deploy [--to M]
  // backfill --catchup (mutually exclusive with --from / --to)
  let fromRaw: string | undefined;
  let toRaw: string | undefined;
  let catchup = false;
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--from') {
      if (next === undefined) throw new ArgParseError('--from requires a block number or `deploy`');
      fromRaw = next;
      i += 1;
    } else if (flag === '--to') {
      if (next === undefined) throw new ArgParseError('--to requires a block number');
      toRaw = next;
      i += 1;
    } else if (flag === '--catchup') {
      catchup = true;
    } else {
      throw new ArgParseError(`unknown flag: ${flag}`);
    }
  }
  if (catchup) {
    if (fromRaw !== undefined || toRaw !== undefined) {
      throw new ArgParseError('--catchup is mutually exclusive with --from / --to');
    }
    return { subcommand: 'backfill', fromMarker: 'catchup' };
  }
  if (fromRaw === undefined) {
    throw new ArgParseError(
      'backfill requires --from N --to M, --from deploy [--to N], or --catchup'
    );
  }
  if (fromRaw === 'deploy') {
    let toBlock: number | undefined;
    if (toRaw !== undefined) {
      const t = Number(toRaw);
      if (!Number.isInteger(t) || t < 0) {
        throw new ArgParseError('--to must be a non-negative integer');
      }
      toBlock = t;
    }
    return { subcommand: 'backfill', fromMarker: 'deploy', toBlock };
  }
  if (toRaw === undefined) {
    throw new ArgParseError('backfill requires --from N --to M');
  }
  const from = Number(fromRaw);
  const to = Number(toRaw);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
    throw new ArgParseError('--from and --to must be non-negative integers with from ≤ to');
  }
  return { subcommand: 'backfill', fromMarker: 'block', fromBlock: from, toBlock: to };
}

export function usage(): string {
  return [
    'usage:',
    '  bam-reader serve',
    '  bam-reader backfill --from <block> --to <block>',
    '  bam-reader backfill --from deploy [--to <block>]',
    '  bam-reader backfill --catchup',
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

  loadDotenv();

  let cfg;
  try {
    cfg = parseEnv(process.env, (msg) => process.stderr.write(`${msg}\n`));
  } catch (err) {
    if (err instanceof EnvConfigError) {
      process.stderr.write(`bam-reader: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  const adapter = createViemL1(cfg.rpcUrl);

  const resolvedStartBlock = resolveStartBlock(cfg, (msg) =>
    process.stderr.write(`${msg}\n`)
  );

  let reader;
  try {
    reader = await createReader(cfg, {
      l1: adapter.l1,
      decodePublicClient: adapter.decodePublicClient,
      verifyPublicClient: adapter.verifyPublicClient,
      startBlock: resolvedStartBlock,
      logger: (event) => {
        // ReaderEvent.message_conflict carries `nonce: bigint`; without
        // the replacer, JSON.stringify throws synchronously and the
        // live-tail tick catches it as a "tick failed" instead of
        // logging the conflict. Same convention as
        // `http/routes.ts:jsonResponse`.
        process.stdout.write(
          `[bam-reader] ${JSON.stringify(event, jsonReplacer)}\n`
        );
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
      let fromBlock: number;
      let toBlock: number;
      try {
        ({ fromBlock, toBlock } = await resolveBackfillRange(
          args,
          cfg,
          adapter.l1,
          reader
        ));
      } catch (err) {
        if (
          err instanceof UnknownChainDeploymentError ||
          err instanceof ArgParseError
        ) {
          process.stderr.write(`bam-reader: ${err.message}\n`);
          try {
            await reader.close();
          } catch {
            /* ignore */
          }
          process.exit(4);
        }
        throw err;
      }
      const result = await reader.backfill(fromBlock, toBlock);
      process.stdout.write(
        `[bam-reader] backfill complete: ${JSON.stringify(result, jsonReplacer)}\n`
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
