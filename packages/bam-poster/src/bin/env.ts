import type { Address, Bytes32 } from 'bam-sdk';

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

/**
 * Coupled `(encoding, decoder, registry)` configuration selected by env at
 * boot. The opt-in profiles route through the canonical addresses pinned
 * in the SDK's deployment table for the configured chain id; the default
 * profile preserves historical Poster behavior (`0x0` addresses, SDK
 * binary encoding).
 */
export type BatchProfile = 'default' | 'canonical-registry' | 'canonical-full';

export const BATCH_PROFILES: readonly BatchProfile[] = [
  'default',
  'canonical-registry',
  'canonical-full',
];

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
  decoderAddress?: Address;
  signatureRegistryAddress?: Address;
  batchProfile: BatchProfile;
  /** Optional bearer-token auth for the HTTP surface. */
  authToken?: string;
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

/**
 * Optional warning sink for soft conflicts that should not abort boot.
 * Defaults to writing to stderr; tests inject a capture array to assert
 * that the right warning(s) fired.
 */
export type EnvWarn = (message: string) => void;

const defaultWarn: EnvWarn = (message) => {
  process.stderr.write(`[bam-poster] ${message}\n`);
};

export function parseEnv(
  env: NodeJS.ProcessEnv = process.env,
  warn: EnvWarn = defaultWarn
): ParsedEnv {
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

  const decoderAddress = optionalAddressEnv(env, 'POSTER_DECODER_ADDRESS');
  const signatureRegistryAddress = optionalAddressEnv(env, 'POSTER_SIGNATURE_REGISTRY');

  const profileRaw = env.POSTER_BATCH_PROFILE;
  let batchProfile: BatchProfile;
  if (profileRaw === undefined || profileRaw === '') {
    batchProfile = 'default';
  } else if ((BATCH_PROFILES as readonly string[]).includes(profileRaw)) {
    batchProfile = profileRaw as BatchProfile;
  } else {
    throw new EnvConfigError(
      `POSTER_BATCH_PROFILE must be one of ${BATCH_PROFILES.join(' | ')} (got ${JSON.stringify(profileRaw)})`
    );
  }

  // Direct-override env vars are retained for diagnostic / experimental
  // use but they break the encoding↔address coupling the canonical
  // profiles enforce. Refuse to combine; warn under default so the
  // operator sees that the overrides are taking effect.
  const hasOverride = decoderAddress !== undefined || signatureRegistryAddress !== undefined;
  if (batchProfile !== 'default' && hasOverride) {
    const conflicting: string[] = [];
    if (decoderAddress !== undefined) conflicting.push('POSTER_DECODER_ADDRESS');
    if (signatureRegistryAddress !== undefined) conflicting.push('POSTER_SIGNATURE_REGISTRY');
    throw new EnvConfigError(
      `POSTER_BATCH_PROFILE=${batchProfile} conflicts with ${conflicting.join(' / ')}; ` +
        `unset the override(s) or set POSTER_BATCH_PROFILE=default`
    );
  }
  if (batchProfile === 'default' && hasOverride) {
    warn(
      'operating with explicit decoder/registry overrides — see POSTER_BATCH_PROFILE for canonical configurations'
    );
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
    decoderAddress,
    signatureRegistryAddress,
    batchProfile,
    authToken: env.POSTER_AUTH_TOKEN && env.POSTER_AUTH_TOKEN.length > 0
      ? env.POSTER_AUTH_TOKEN
      : undefined,
  };
}
