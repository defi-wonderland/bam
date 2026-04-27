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
 * Parse `process.env` into a `ReaderConfig`. Defaults match the plan's
 * Public API / wire format section.
 */
export function parseEnv(env: NodeJS.ProcessEnv = process.env): ReaderConfig {
  const chainId = parseInteger(requireEnv(env, 'READER_CHAIN_ID'), 'READER_CHAIN_ID', {
    min: 1,
  });

  const rpcUrl = requireEnv(env, 'READER_RPC_URL');
  const bamCoreAddress = requireAddress(env, 'READER_BAM_CORE');

  const beaconUrl = optionalString(env, 'READER_BEACON_URL');
  const blobscanUrl = optionalString(env, 'READER_BLOBSCAN_URL');

  const contentTags = parseCsvTags(env.READER_CONTENT_TAGS, 'READER_CONTENT_TAGS');

  const reorgWindowBlocks = clampReorgWindow(
    env.READER_REORG_WINDOW_BLOCKS ? Number(env.READER_REORG_WINDOW_BLOCKS) : 32
  );

  const dbUrl = requireEnv(env, 'READER_DB_URL');

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
