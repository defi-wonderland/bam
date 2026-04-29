/**
 * CLI-level env parsing for the BAM Reader.
 *
 * Centralizes the translation from `process.env` into a `ReaderConfig`
 * shape that `factory.ts` consumes. Required vars throw
 * `EnvConfigError` with a stable code; the CLI surfaces this as a
 * fixed exit. Mirrors the Poster's env module shape.
 */

import type { Address, Bytes32 } from 'bam-sdk';

import { ChainIdMismatch } from '../errors.js';
import { clampReorgWindow } from '../reorg-watcher.js';
import type { ReaderConfig } from '../types.js';

export class EnvConfigError extends Error {
  readonly code = 'env_config_error';
  constructor(message: string) {
    super(message);
    this.name = 'EnvConfigError';
  }
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (v === undefined || v === '') {
    throw new EnvConfigError(`missing required env ${key}`);
  }
  return v;
}

function requireAddress(env: NodeJS.ProcessEnv, key: string): Address {
  const v = requireEnv(env, key);
  if (!ADDRESS_RE.test(v)) {
    throw new EnvConfigError(`${key} must be a 20-byte hex address`);
  }
  return v as Address;
}

function optionalString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key];
  return v === undefined || v === '' ? undefined : v;
}

function parseCsvTags(raw: string | undefined, key: string): Bytes32[] | undefined {
  if (raw === undefined || raw === '') return undefined;
  const tags = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const t of tags) {
    if (!BYTES32_RE.test(t)) {
      throw new EnvConfigError(`${key} contains an invalid bytes32: ${t}`);
    }
  }
  return tags as Bytes32[];
}

function parseInteger(raw: string, key: string, opts?: { min?: number; max?: number }): number {
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new EnvConfigError(`${key} must be an integer`);
  }
  if (opts?.min !== undefined && n < opts.min) {
    throw new EnvConfigError(`${key} must be ≥ ${opts.min}`);
  }
  if (opts?.max !== undefined && n > opts.max) {
    throw new EnvConfigError(`${key} must be ≤ ${opts.max}`);
  }
  return n;
}

function parseBigint(raw: string, key: string, opts?: { min?: bigint }): bigint {
  let v: bigint;
  try {
    v = BigInt(raw);
  } catch {
    throw new EnvConfigError(`${key} must be a positive integer (got ${raw})`);
  }
  if (opts?.min !== undefined && v < opts.min) {
    throw new EnvConfigError(`${key} must be ≥ ${opts.min}`);
  }
  return v;
}

/**
 * Default sentinel returned when neither `READER_DB_URL` nor
 * `POSTGRES_URL` is set. The factory recognises this as the in-process
 * PGLite path (mirrors the Poster's `POSTGRES_URL`-unset behaviour).
 */
const MEMORY_DB_URL = 'memory:';

/**
 * Parse `process.env` into a `ReaderConfig`. Defaults match the plan's
 * Public API / wire format section.
 *
 * Optional `warn` sink receives a one-line message when the parser
 * applies a fallback the operator probably wants to see (e.g.
 * defaulting to in-process PGLite). The CLI wires this to stderr;
 * tests use it to assert the warning surfaces without scraping
 * `process.stderr`.
 */
export function parseEnv(
  env: NodeJS.ProcessEnv = process.env,
  warn?: (message: string) => void
): ReaderConfig {
  const chainId = parseInteger(requireEnv(env, 'READER_CHAIN_ID'), 'READER_CHAIN_ID', {
    min: 1,
  });

  // Cross-check against POSTER_CHAIN_ID when both are present in the
  // environment (e.g. `pnpm dev` runs both services from the same
  // shell). Catches the split-brain case where an operator points
  // each service at a different chain. Silent when either var is unset.
  const posterChainIdRaw = optionalString(env, 'POSTER_CHAIN_ID');
  if (posterChainIdRaw !== undefined) {
    const posterChainId = parseInteger(posterChainIdRaw, 'POSTER_CHAIN_ID', { min: 1 });
    if (posterChainId !== chainId) {
      throw new EnvConfigError(
        `READER_CHAIN_ID=${chainId} does not match POSTER_CHAIN_ID=${posterChainId}; refusing to start. ` +
          `Both services share a Postgres substrate — pointing them at different chains would cross-write rows.`
      );
    }
  }

  const rpcUrl = requireEnv(env, 'READER_RPC_URL');
  const bamCoreAddress = requireAddress(env, 'READER_BAM_CORE');

  const beaconUrl = optionalString(env, 'READER_BEACON_URL');
  const blobscanUrl = optionalString(env, 'READER_BLOBSCAN_URL');

  const contentTags = parseCsvTags(env.READER_CONTENT_TAGS, 'READER_CONTENT_TAGS');

  const reorgWindowBlocks = clampReorgWindow(
    env.READER_REORG_WINDOW_BLOCKS ? Number(env.READER_REORG_WINDOW_BLOCKS) : 32
  );

  // DSN resolution mirrors the Poster's "just run it" defaulting:
  //   1. `READER_DB_URL` — explicit Reader-side override.
  //   2. `POSTGRES_URL` — the shared workspace DSN (also what
  //      Vercel-managed Postgres bindings ship with). Used by the
  //      Poster as its primary DSN; reusing it here means a
  //      `pnpm dev` checkout doesn't need two copies of the same
  //      connection string.
  //   3. Fallback: `memory:` — in-process PGLite, non-durable.
  //      Operators wanting durability set the env var explicitly.
  const readerDbUrl = optionalString(env, 'READER_DB_URL');
  const postgresUrl = optionalString(env, 'POSTGRES_URL');
  let dbUrl: string;
  let dbUrlSource: string;
  if (readerDbUrl !== undefined) {
    dbUrl = readerDbUrl;
    dbUrlSource = 'READER_DB_URL';
  } else if (postgresUrl !== undefined) {
    dbUrl = postgresUrl;
    dbUrlSource = 'POSTGRES_URL';
  } else {
    dbUrl = MEMORY_DB_URL;
    dbUrlSource = '(default)';
    warn?.(
      'bam-reader: neither READER_DB_URL nor POSTGRES_URL set; defaulting to in-process PGLite (memory:). ' +
        'Confirmed rows are non-durable across restarts.'
    );
  }
  // Validate scheme up front so a bad value fails as `EnvConfigError`
  // (clean exit code 2 + clear source attribution) rather than later as
  // a generic Error from the store factory that names the wrong env var.
  if (
    dbUrl !== 'memory:' &&
    dbUrl !== 'memory' &&
    !dbUrl.startsWith('postgres:') &&
    !dbUrl.startsWith('postgresql:')
  ) {
    // Echo only the scheme — the rest of the DSN may contain
    // credentials (e.g. `postgres://user:pass@host/db`), and the CLI
    // surfaces this message verbatim to stderr/logs (qodo PR #29
    // follow-up). Cap the scheme too so a value that has no colon
    // can't leak its full content via this path.
    const colonIdx = dbUrl.indexOf(':');
    const scheme =
      colonIdx > 0 ? dbUrl.slice(0, Math.min(colonIdx, 32)) : '(no scheme)';
    throw new EnvConfigError(
      `${dbUrlSource} has unsupported DSN scheme "${scheme}". ` +
        `Use a postgres:// URL, or memory: for in-process PGLite.`
    );
  }

  const httpBind = env.READER_HTTP_BIND ?? '127.0.0.1';
  const httpPort = parseInteger(env.READER_HTTP_PORT ?? '8788', 'READER_HTTP_PORT', {
    min: 0,
    max: 65535,
  });

  const ethCallGasCap = env.READER_ETH_CALL_GAS_CAP
    ? parseBigint(env.READER_ETH_CALL_GAS_CAP, 'READER_ETH_CALL_GAS_CAP', { min: 21_000n })
    : 50_000_000n;

  const ethCallTimeoutMs = parseInteger(
    env.READER_ETH_CALL_TIMEOUT_MS ?? '5000',
    'READER_ETH_CALL_TIMEOUT_MS',
    { min: 1 }
  );

  const startBlock = env.READER_START_BLOCK
    ? parseInteger(env.READER_START_BLOCK, 'READER_START_BLOCK', { min: 0 })
    : undefined;

  const logScanChunkBlocks = parseInteger(
    env.READER_LOG_SCAN_CHUNK_BLOCKS ?? '2000',
    'READER_LOG_SCAN_CHUNK_BLOCKS',
    { min: 64, max: 100_000 }
  );

  const backfillProgressIntervalMs = parseInteger(
    env.READER_BACKFILL_PROGRESS_INTERVAL_MS ?? '10000',
    'READER_BACKFILL_PROGRESS_INTERVAL_MS',
    { min: 1 }
  );

  const backfillProgressEveryChunks = parseInteger(
    env.READER_BACKFILL_PROGRESS_EVERY_CHUNKS ?? '5',
    'READER_BACKFILL_PROGRESS_EVERY_CHUNKS',
    { min: 1 }
  );

  return {
    chainId,
    rpcUrl,
    bamCoreAddress,
    beaconUrl,
    blobscanUrl,
    contentTags,
    reorgWindowBlocks,
    dbUrl,
    httpBind,
    httpPort,
    ethCallGasCap,
    ethCallTimeoutMs,
    startBlock,
    logScanChunkBlocks,
    backfillProgressIntervalMs,
    backfillProgressEveryChunks,
  };
}

export interface ChainIdReadable {
  getChainId(): Promise<number>;
}

/**
 * At construction time, cross-check the configured `READER_CHAIN_ID`
 * against the RPC's reported chain id (red-team C-3). A mismatch
 * throws `ChainIdMismatch` and refuses to serve.
 */
export async function assertChainIdMatches(
  client: ChainIdReadable,
  expectedChainId: number
): Promise<void> {
  const observed = await client.getChainId();
  if (observed !== expectedChainId) {
    throw new ChainIdMismatch(
      `RPC reports chain id ${observed}, but READER_CHAIN_ID=${expectedChainId}; refusing to serve`
    );
  }
}
