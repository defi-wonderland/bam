/**
 * Resolve canonical `(decoder, signatureRegistry)` addresses from the
 * SDK's deployment table for a given `BatchProfile`.
 *
 * The Poster's profile selector is the only canonical-configuration knob.
 * `default` produces zero addresses (current behavior).
 * `canonical-registry` requires `ECDSARegistry` to be pinned.
 * `canonical-full` requires both `ABIDecoder` and `ECDSARegistry`.
 *
 * Missing entries fail fast at boot — the operator boundary is where this
 * surfaces, never on the wire as a silent downgrade.
 *
 * The `deploymentsLookup` injector defaults to `bam-sdk`'s `getDeployment`
 * but tests can supply a per-chain fixture without mutating the shipped
 * deployments table.
 */

import type { Address } from 'bam-sdk';
import { getDeployment, type ChainDeployment } from 'bam-sdk';
import { zeroAddress } from 'viem';

import { EnvConfigError, type BatchProfile } from './bin/env.js';

export type DeploymentsLookup = (chainId: number) => ChainDeployment | undefined;

export interface ResolvedProfileAddresses {
  decoderAddress: Address;
  signatureRegistryAddress: Address;
}

export function resolveProfileAddresses(
  profile: BatchProfile,
  chainId: number,
  deploymentsLookup: DeploymentsLookup = getDeployment
): ResolvedProfileAddresses {
  if (profile === 'default') {
    return {
      decoderAddress: zeroAddress,
      signatureRegistryAddress: zeroAddress,
    };
  }

  const deployment = deploymentsLookup(chainId);
  if (!deployment) {
    throw new EnvConfigError(
      `POSTER_BATCH_PROFILE=${profile} requires a SDK deployment for chain ${chainId}, but none is pinned`
    );
  }

  const ecdsa = deployment.contracts.ECDSARegistry;
  if (!ecdsa) {
    throw new EnvConfigError(
      `POSTER_BATCH_PROFILE=${profile} requires ECDSARegistry for chain ${chainId}, but the SDK lookup has no ECDSARegistry entry`
    );
  }

  if (profile === 'canonical-registry') {
    return {
      decoderAddress: zeroAddress,
      signatureRegistryAddress: ecdsa.address,
    };
  }

  // canonical-full also needs ABIDecoder.
  const abiDecoder = deployment.contracts.ABIDecoder;
  if (!abiDecoder) {
    throw new EnvConfigError(
      `POSTER_BATCH_PROFILE=${profile} requires ABIDecoder for chain ${chainId}, but the SDK lookup has no ABIDecoder entry`
    );
  }

  return {
    decoderAddress: abiDecoder.address,
    signatureRegistryAddress: ecdsa.address,
  };
}
