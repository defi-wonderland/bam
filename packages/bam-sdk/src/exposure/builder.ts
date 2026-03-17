/**
 * Exposure Transaction Builder
 * @module bam-sdk/exposure/builder
 *
 * Builds exposure transactions for on-chain tweet exposure.
 */

import type { ExposureParams, ParsedMessage } from './types.js';
import type { Blob, KZGProof } from '../kzg/types.js';
import type { Bytes32 } from '../types.js';
import {
  generateProofsForByteRange,
  loadTrustedSetup,
  commitToBlob,
} from '../kzg/proof-generator.js';
import { getMessagePosition } from './blob-parser.js';

/**
 * Build exposure parameters for a message
 * @param blob Raw blob data
 * @param message Parsed message to expose
 * @param blsSignature BLS signature on the message
 * @param versionedHash EIP-4844 versioned hash of the blob
 * @param batchStartOffset Optional batch start offset (defaults to message's offset)
 * @returns Exposure parameters for contract call
 */
export function buildExposureParams(
  blob: Blob,
  message: ParsedMessage,
  blsSignature: Uint8Array,
  versionedHash: Bytes32,
  batchStartOffset?: number
): ExposureParams {
  // Ensure KZG setup is loaded
  loadTrustedSetup();

  // Get blob commitment
  const { commitment } = commitToBlob(blob);

  // Get message position
  const position = getMessagePosition(message);

  // Use provided batchStartOffset or calculate from message
  const offset = batchStartOffset ?? message.absoluteByteOffset - message.byteOffset;

  // Generate KZG proofs for the byte range using absolute offset
  const proofBatch = generateProofsForByteRange(
    blob,
    commitment,
    position.absoluteByteOffset,
    position.byteLength
  );

  return {
    versionedHash,
    kzgProofs: proofBatch.proofs,
    batchStartOffset: offset,
    byteOffset: position.byteOffset,
    byteLength: position.byteLength,
    messageBytes: message.rawBytes,
    blsSignature,
    registrationProof: new Uint8Array(0),
  };
}

/**
 * Build exposure parameters from raw data
 * @param blob Raw blob data
 * @param byteOffset Starting byte offset of message (relative to batch start)
 * @param messageBytes Raw message bytes
 * @param blsSignature BLS signature
 * @param versionedHash EIP-4844 versioned hash of the blob
 * @param batchStartOffset Byte offset where batch starts in blob (default: 0)
 * @returns Exposure parameters for contract call
 */
export function buildExposureParamsRaw(
  blob: Blob,
  byteOffset: number,
  messageBytes: Uint8Array,
  blsSignature: Uint8Array,
  versionedHash: Bytes32,
  batchStartOffset = 0
): ExposureParams {
  loadTrustedSetup();

  const { commitment } = commitToBlob(blob);
  const byteLength = messageBytes.length;

  // Calculate absolute offset for KZG proofs
  const absoluteByteOffset = batchStartOffset + byteOffset;

  const proofBatch = generateProofsForByteRange(blob, commitment, absoluteByteOffset, byteLength);

  return {
    versionedHash,
    kzgProofs: proofBatch.proofs,
    batchStartOffset,
    byteOffset,
    byteLength,
    messageBytes,
    blsSignature,
    registrationProof: new Uint8Array(0),
  };
}

/**
 * Encode exposure params for contract call
 * @param params Exposure parameters
 * @returns ABI-encoded parameters
 */
export function encodeExposureParams(params: ExposureParams): {
  versionedHash: Bytes32;
  kzgProofs: Array<{
    z: bigint;
    y: bigint;
    commitment: Uint8Array;
    proof: Uint8Array;
  }>;
  batchStartOffset: bigint;
  byteOffset: bigint;
  byteLength: bigint;
  messageBytes: Uint8Array;
  blsSignature: Uint8Array;
  registrationProof: Uint8Array;
} {
  return {
    versionedHash: params.versionedHash,
    kzgProofs: params.kzgProofs.map((p) => ({
      z: p.z,
      y: p.y,
      commitment: p.commitment,
      proof: p.proof,
    })),
    batchStartOffset: BigInt(params.batchStartOffset),
    byteOffset: BigInt(params.byteOffset),
    byteLength: BigInt(params.byteLength),
    messageBytes: params.messageBytes,
    blsSignature: params.blsSignature,
    registrationProof: params.registrationProof,
  };
}

/**
 * Estimate gas for exposure transaction
 * Based on spec: 350k for 4 FEs + BLS verification
 * @param fieldElementCount Number of field elements in proof
 * @returns Estimated gas
 */
export function estimateExposureGas(fieldElementCount: number): bigint {
  // Base gas for transaction overhead
  const baseGas = 21000n;

  // Gas per field element proof verification (~50k each)
  const proofGas = BigInt(fieldElementCount) * 50000n;

  // BLS verification gas (~100k)
  const blsGas = 100000n;

  // Hook execution gas (200k max, estimate 50k)
  const hookGas = 50000n;

  // Storage operations (~40k)
  const storageGas = 40000n;

  return baseGas + proofGas + blsGas + hookGas + storageGas;
}

/** Maximum usable bytes in a blob */
const MAX_USABLE_BYTES = 4096 * 31; // 126,976 bytes

/**
 * Validate exposure params before submission
 * @param params Exposure parameters
 * @throws Error if params are invalid
 */
export function validateExposureParams(params: ExposureParams): void {
  if (!params.versionedHash || params.versionedHash === '0x' + '0'.repeat(64)) {
    throw new Error('Invalid versioned hash');
  }

  if (params.kzgProofs.length === 0) {
    throw new Error('No KZG proofs provided');
  }

  if (params.messageBytes.length === 0) {
    throw new Error('Empty message bytes');
  }

  if (params.blsSignature.length !== 96) {
    throw new Error(`Invalid BLS signature length: ${params.blsSignature.length} (expected 96)`);
  }

  // Validate batchStartOffset bounds
  if (params.batchStartOffset < 0) {
    throw new Error(`Invalid batchStartOffset: ${params.batchStartOffset} (must be >= 0)`);
  }

  if (params.batchStartOffset >= MAX_USABLE_BYTES) {
    throw new Error(
      `Invalid batchStartOffset: ${params.batchStartOffset} (must be < ${MAX_USABLE_BYTES})`
    );
  }

  // Validate byteOffset bounds
  if (params.byteOffset < 0) {
    throw new Error(`Invalid byteOffset: ${params.byteOffset} (must be >= 0)`);
  }

  // Validate that the message fits in the blob
  const absoluteEnd = params.batchStartOffset + params.byteOffset + params.byteLength;
  if (absoluteEnd > MAX_USABLE_BYTES) {
    throw new Error(
      `Message exceeds blob capacity: batchStartOffset(${params.batchStartOffset}) + byteOffset(${params.byteOffset}) + byteLength(${params.byteLength}) = ${absoluteEnd} > ${MAX_USABLE_BYTES}`
    );
  }

  // Validate each KZG proof
  for (const proof of params.kzgProofs) {
    if (proof.commitment.length !== 48) {
      throw new Error(`Invalid commitment length: ${proof.commitment.length}`);
    }
    if (proof.proof.length !== 48) {
      throw new Error(`Invalid proof length: ${proof.proof.length}`);
    }
    if (proof.z < 0n || proof.z >= 4096n) {
      throw new Error(`Field element index out of range: ${proof.z}`);
    }
  }

  // Validate proofs are in order
  for (let i = 1; i < params.kzgProofs.length; i++) {
    if (params.kzgProofs[i].z <= params.kzgProofs[i - 1].z) {
      throw new Error('KZG proofs must be in ascending order of z');
    }
  }
}

/**
 * Create a minimal exposure params for testing
 * @param messageBytes Message to expose
 * @param versionedHash Versioned hash (default: test hash)
 * @param batchStartOffset Batch start offset (default: 0)
 * @returns Minimal params for testing (without real proofs)
 */
export function createTestExposureParams(
  messageBytes: Uint8Array,
  versionedHash: Bytes32 = ('0x01' + 'ab'.repeat(31)) as Bytes32,
  batchStartOffset = 0
): ExposureParams {
  // Create mock KZG proof
  const mockProof: KZGProof = {
    z: 0n,
    y: 0n,
    commitment: new Uint8Array(48),
    proof: new Uint8Array(48),
  };

  return {
    versionedHash,
    kzgProofs: [mockProof],
    batchStartOffset,
    byteOffset: 0,
    byteLength: messageBytes.length,
    messageBytes,
    blsSignature: new Uint8Array(96),
    registrationProof: new Uint8Array(0),
  };
}
