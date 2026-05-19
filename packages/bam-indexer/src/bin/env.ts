/**
 * Env parsing for the `bam-indexer` CLI. Strict — any malformed
 * value produces an `EnvConfigError` with a stable message the bin
 * maps to exit code 2 (matches `bam-reader`'s pattern).
 */

import type { Bytes32 } from 'bam-sdk';

import type { IndexerConfig } from '../types.js';
import { EnvConfigError } from '../errors.js';

const DEFAULT_POLL_MS = 5000;
const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_HTTP_BIND = '127.0.0.1';
const DEFAULT_HTTP_PORT = 8789;

export function parseEnv(env: NodeJS.ProcessEnv = process.env): IndexerConfig {
  const chainIdRaw = env.INDEXER_CHAIN_ID;
  if (chainIdRaw === undefined || chainIdRaw === '') {
    throw new EnvConfigError('INDEXER_CHAIN_ID is required');
  }
  if (!/^[0-9]+$/.test(chainIdRaw)) {
    throw new EnvConfigError(`INDEXER_CHAIN_ID is not a positive integer: ${chainIdRaw}`);
  }
  const chainId = Number(chainIdRaw);

  const sourceDbUrl = env.INDEXER_DB_URL;
  if (sourceDbUrl === undefined || sourceDbUrl === '') {
    throw new EnvConfigError('INDEXER_DB_URL is required (read-only DSN for bam-store)');
  }
  const writeDbUrl = env.INDEXER_WRITE_DB_URL ?? sourceDbUrl;
  // Same DSN is permitted in dev; doc the role-split posture in
  // README. The default falls back to sourceDbUrl so a single-DSN
  // local stack works out of the box.

  // poll cadence and batch size must be > 0: a zero poll spins the
  // serve loop tightly, a zero batch wedges forward progress.
  const pollMs = parsePositiveInt(env.INDEXER_POLL_MS, DEFAULT_POLL_MS, 'INDEXER_POLL_MS', 1);
  const batchSize = parsePositiveInt(env.INDEXER_BATCH_SIZE, DEFAULT_BATCH_SIZE, 'INDEXER_BATCH_SIZE', 1);
  const httpBind = env.INDEXER_HTTP_BIND ?? DEFAULT_HTTP_BIND;
  // Port 0 is legitimate: Node binds an OS-assigned port (handy in tests).
  const httpPort = parsePositiveInt(env.INDEXER_HTTP_PORT, DEFAULT_HTTP_PORT, 'INDEXER_HTTP_PORT');

  const twitterTag = parseBytes32(env.INDEXER_TWITTER_TAG, 'INDEXER_TWITTER_TAG');

  return {
    chainId,
    sourceDbUrl,
    writeDbUrl,
    pollMs,
    batchSize,
    httpBind,
    httpPort,
    twitterTag,
  };
}

function parseBytes32(raw: string | undefined, name: string): Bytes32 {
  if (raw === undefined || raw === '') {
    throw new EnvConfigError(`${name} is required (0x-prefixed 32-byte hex)`);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new EnvConfigError(`${name} is not a 32-byte 0x-hex string: ${raw}`);
  }
  return raw.toLowerCase() as Bytes32;
}

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
  min = 0,
): number {
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]+$/.test(raw)) {
    throw new EnvConfigError(`${name} is not a non-negative integer: ${raw}`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    throw new EnvConfigError(`${name} is not a safe integer: ${raw}`);
  }
  if (n < min) {
    throw new EnvConfigError(`${name} must be >= ${min}: ${raw}`);
  }
  return n;
}

export { EnvConfigError } from '../errors.js';
