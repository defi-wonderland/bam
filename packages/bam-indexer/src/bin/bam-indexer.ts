#!/usr/bin/env node
/**
 * `bam-indexer` CLI. Two subcommands:
 *
 *   - `serve` — long-running daemon. Runs the tick loop + HTTP
 *     server. SIGTERM/SIGINT triggers a clean shutdown.
 *   - `reset --handler <name> --yes` — truncate `<handler.schema>.*`
 *     and delete the handler's cursor row. `--yes` required.
 *
 * Exit codes (mirrors bam-reader):
 *   0 — graceful shutdown / reset success
 *   1 — uncaught error
 *   2 — env config error
 *   3 — chain id mismatch (reserved; not yet wired)
 *   4 — bad subcommand / missing --yes / unknown handler
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { config as dotenvConfig } from 'dotenv';

import type { Bytes32 } from 'bam-sdk';

import { createIndexer } from '../factory.js';
import { EnvConfigError, parseEnv } from './env.js';
import { createPostReplyHandler } from '../handlers/post-reply/handler.js';
import { UnknownHandlerError } from '../errors.js';

// keccak256(utf8("bam-twitter.v1")) — must stay in sync with
// `apps/bam-twitter/src/lib/constants.ts`.
const TWITTER_TAG =
  '0xf0fea94ffd2ae32ed878c57e3427bbffab46d333d09837bc640d952795090718' as Bytes32;

const HANDLERS = [
  createPostReplyHandler({ name: 'twitter', contentTag: TWITTER_TAG, schema: 'twitter' }),
];

function loadDotenv(): void {
  const explicit = process.env.INDEXER_ENV_FILE;
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

async function runServe(): Promise<number> {
  loadDotenv();
  let cfg;
  try {
    cfg = parseEnv();
  } catch (err) {
    if (err instanceof EnvConfigError) {
      process.stderr.write(`[bam-indexer] env error: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
  const indexer = await createIndexer(cfg, { handlers: HANDLERS });
  const { host, port } = await indexer.health();
  process.stderr.write(`[bam-indexer] listening on http://${host}:${port}\n`);
  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`[bam-indexer] ${signal} received; shutting down\n`);
    await indexer.close();
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  await indexer.serve();
  return 0;
}

async function runReset(argv: string[]): Promise<number> {
  // Parse `--handler <name> --yes`
  let handlerName: string | undefined;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--handler') {
      handlerName = argv[i + 1];
      i++;
    } else if (argv[i] === '--yes') {
      yes = true;
    }
  }
  if (handlerName === undefined) {
    process.stderr.write('[bam-indexer] reset: --handler <name> is required\n');
    return 4;
  }
  if (!yes) {
    process.stderr.write(
      `[bam-indexer] reset --handler ${handlerName}: refusing without --yes (destructive)\n`
    );
    return 4;
  }
  loadDotenv();
  let cfg;
  try {
    cfg = parseEnv();
  } catch (err) {
    if (err instanceof EnvConfigError) {
      process.stderr.write(`[bam-indexer] env error: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
  const indexer = await createIndexer(cfg, { handlers: HANDLERS });
  try {
    await indexer.resetHandler(handlerName);
    process.stderr.write(`[bam-indexer] reset handler ${handlerName} OK\n`);
    return 0;
  } catch (err) {
    if (err instanceof UnknownHandlerError) {
      process.stderr.write(`[bam-indexer] reset: ${err.message}\n`);
      return 4;
    }
    throw err;
  } finally {
    await indexer.close();
  }
}

async function main(): Promise<number> {
  const [subcommand, ...rest] = process.argv.slice(2);
  switch (subcommand) {
    case 'serve':
      return await runServe();
    case 'reset':
      return await runReset(rest);
    default:
      process.stderr.write(
        `[bam-indexer] usage: bam-indexer <serve | reset --handler <name> --yes>\n`
      );
      return 4;
  }
}

void main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`[bam-indexer] uncaught: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  }
);
