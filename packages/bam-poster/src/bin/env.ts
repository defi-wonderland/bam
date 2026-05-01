import type { Address, Bytes32 } from 'bam-sdk';
import { getDeployment } from 'bam-sdk';
import { zeroAddress } from 'viem';

import { clampReorgWindow } from '../submission/reorg-watcher.js';
import { canonicalTag } from '../util/canonical.js';

/**
 * CLI-level env parsing. Centralizes the translation from process.env
 * to a shape the factory accepts. Throws a stable error on missing
 * required values — the CLI surfaces this as a fixed exit code.
 */
export class EnvConfigError extends Error {
  readonly code = 'env_config_error';
}

export type BatchEncoding = 'binary' | 'abi';

export interface ParsedEnv {
  allowlistedTags: Bytes32[];
  chainId: number;
  bamCoreAddress: Address;
  rpcUrl: string;
  signerPrivateKey: `0x${string}`;
  reorgWindowBlocks: number;
  host: string;
  port: number;
  postgresUrl?: string;
  /**
   * Wire format for the on-chain batch payload.
   * - `binary` (default): packed binary codec, decoded in the Reader's JS.
   * - `abi`: ERC-8180 v1 ABI shape, decoded by the on-chain `ABIDecoder`.
   */
  batchEncoding: BatchEncoding;
  /**
   * Always set: `zeroAddress` for `batchEncoding === 'binary'`,
   * the registry-resolved `ABIDecoder` for `'abi'`. Callers no longer
   * need to default this with `?? zeroAddress`.
   */
  decoderAddress: Address;
  signatureRegistryAddress?: Address;
  /** Optional bearer-token auth for the HTTP surface. */
  authToken?: string;
  /**
   * Operator-visible packing-loss-streak warning threshold (T023).
   * Default 10. Detection-only; tags whose streak crosses this
   * threshold are flagged in `/health` with `warn: true`.
   */
  packingLossStreakWarnThreshold: number;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (v === undefined || v === '') {
    throw new EnvConfigError(`missing required env ${key}`);
  }
  return v;
}

function optionalAddressEnv(env: NodeJS.ProcessEnv, key: string): Address | undefined {
  const v = env[key];
  if (v === undefined || v === '') return undefined;
  if (!ADDRESS_RE.test(v)) {
    throw new EnvConfigError(`${key} must be a 20-byte hex address`);
  }
  return v as Address;
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
  if (!ADDRESS_RE.test(bamCoreAddress)) {
    throw new EnvConfigError('POSTER_BAM_CORE_ADDRESS must be a 20-byte hex address');
  }

  const signatureRegistryAddress = optionalAddressEnv(env, 'POSTER_SIGNATURE_REGISTRY');

  // POSTER_BATCH_ENCODING controls the wire format for posted batches.
  // Empty string is rejected (C-7) — use unset to take the default.
  // Any non-canonical value (including `ABI`) is rejected — no aliasing.
  const rawBatchEncoding = env.POSTER_BATCH_ENCODING;
  let batchEncoding: BatchEncoding;
  if (rawBatchEncoding === undefined) {
    batchEncoding = 'binary';
  } else if (rawBatchEncoding === '') {
    throw new EnvConfigError(
      'POSTER_BATCH_ENCODING is set to an empty string; unset it or use {binary|abi}'
    );
  } else if (rawBatchEncoding === 'binary' || rawBatchEncoding === 'abi') {
    batchEncoding = rawBatchEncoding;
  } else {
    throw new EnvConfigError(
      `POSTER_BATCH_ENCODING must be \"binary\" or \"abi\" (got \"${rawBatchEncoding}\")`
    );
  }

  let decoderAddress: Address;
  if (batchEncoding === 'binary') {
    decoderAddress = zeroAddress;
  } else {
    // 'abi' — resolve from the deployments registry; fail closed when missing.
    const deployment = getDeployment(chainId);
    const entry = deployment?.contracts.ABIDecoder;
    if (!entry) {
      throw new EnvConfigError(
        `POSTER_BATCH_ENCODING=abi requires an ABIDecoder entry for chainId ${chainId} ` +
          `in packages/bam-contracts/deployments/${chainId}.json (none found)`
      );
    }
    decoderAddress = entry.address as Address;
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

  const packingLossStreakWarnThresholdStr =
    env.POSTER_PACKING_LOSS_STREAK_WARN_THRESHOLD;
  let packingLossStreakWarnThreshold = 10;
  if (packingLossStreakWarnThresholdStr !== undefined && packingLossStreakWarnThresholdStr !== '') {
    const n = Number(packingLossStreakWarnThresholdStr);
    if (!Number.isInteger(n) || n < 1) {
      throw new EnvConfigError(
        'POSTER_PACKING_LOSS_STREAK_WARN_THRESHOLD must be a positive integer'
      );
    }
    packingLossStreakWarnThreshold = n;
  }

  return {
    // Canonicalize casing here so the store adapters, scheduler map,
    // and allowlist comparisons all see one representation.
    allowlistedTags: tags.map((t) => canonicalTag(t as Bytes32)),
    chainId,
    bamCoreAddress: bamCoreAddress as Address,
    rpcUrl,
    signerPrivateKey: signerPrivateKey as `0x${string}`,
    reorgWindowBlocks,
    host,
    port,
    postgresUrl: env.POSTGRES_URL,
    batchEncoding,
    decoderAddress,
    signatureRegistryAddress,
    authToken: env.POSTER_AUTH_TOKEN && env.POSTER_AUTH_TOKEN.length > 0
      ? env.POSTER_AUTH_TOKEN
      : undefined,
    packingLossStreakWarnThreshold,
  };
}
