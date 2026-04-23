import type { Address, Bytes32 } from 'bam-sdk';

import { clampReorgWindow } from '../submission/reorg-watcher.js';

/**
 * CLI-level env parsing (plan §Rollout → Configuration). Centralizes
 * the translation from process.env to a shape the factory accepts.
 * Throws a stable error on missing required values — the CLI surfaces
 * this as a fixed exit code.
 */
export class EnvConfigError extends Error {
  readonly code = 'env_config_error';
}

export interface ParsedEnv {
  allowlistedTags: Bytes32[];
  chainId: number;
  bamCoreAddress: Address;
  rpcUrl: string;
  signerPrivateKey: `0x${string}`;
  reorgWindowBlocks: number;
  host: string;
  port: number;
  sqlitePath?: string;
  postgresUrl?: string;
  decoderAddress?: Address;
  signatureRegistryAddress?: Address;
  /** FU-12: optional bearer-token auth for the HTTP surface. */
  authToken?: string;
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (v === undefined || v === '') {
    throw new EnvConfigError(`missing required env ${key}`);
  }
  return v;
}

export function parseEnv(env: NodeJS.ProcessEnv = process.env): ParsedEnv {
  const csvTags = requireEnv(env, 'POSTER_ALLOWED_TAGS');
  const tags = csvTags
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (tags.length === 0) {
    throw new EnvConfigError('POSTER_ALLOWED_TAGS cannot be empty');
  }
  for (const t of tags) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(t)) {
      throw new EnvConfigError(`POSTER_ALLOWED_TAGS contains an invalid bytes32: ${t}`);
    }
  }

  const chainIdStr = requireEnv(env, 'POSTER_CHAIN_ID');
  const chainId = Number(chainIdStr);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new EnvConfigError(`POSTER_CHAIN_ID must be a positive integer`);
  }

  const bamCoreAddress = requireEnv(env, 'POSTER_BAM_CORE_ADDRESS');
  if (!/^0x[0-9a-fA-F]{40}$/.test(bamCoreAddress)) {
    throw new EnvConfigError('POSTER_BAM_CORE_ADDRESS must be a 20-byte hex address');
  }

  const rpcUrl = requireEnv(env, 'POSTER_RPC_URL');

  const signerPrivateKey = requireEnv(env, 'POSTER_SIGNER_PRIVATE_KEY');
  if (!/^0x[0-9a-fA-F]{64}$/.test(signerPrivateKey)) {
    throw new EnvConfigError('POSTER_SIGNER_PRIVATE_KEY must be 32 hex-encoded bytes');
  }

  const reorgWindowBlocks = clampReorgWindow(
    env.POSTER_REORG_WINDOW_BLOCKS ? Number(env.POSTER_REORG_WINDOW_BLOCKS) : 32
  );

  const host = env.POSTER_HOST ?? '127.0.0.1';
  const portStr = env.POSTER_PORT ?? '8787';
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new EnvConfigError('POSTER_PORT must be a valid port number');
  }

  return {
    allowlistedTags: tags as Bytes32[],
    chainId,
    bamCoreAddress: bamCoreAddress as Address,
    rpcUrl,
    signerPrivateKey: signerPrivateKey as `0x${string}`,
    reorgWindowBlocks,
    host,
    port,
    sqlitePath: env.POSTER_SQLITE_PATH,
    postgresUrl: env.POSTGRES_URL,
    decoderAddress: env.POSTER_DECODER_ADDRESS as Address | undefined,
    signatureRegistryAddress: env.POSTER_SIGNATURE_REGISTRY as Address | undefined,
    authToken: env.POSTER_AUTH_TOKEN && env.POSTER_AUTH_TOKEN.length > 0
      ? env.POSTER_AUTH_TOKEN
      : undefined,
  };
}
