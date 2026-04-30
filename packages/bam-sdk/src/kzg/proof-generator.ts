/**
 * KZG Proof Generator for BAM
 * @module bam-sdk/kzg/proof-generator
 *
 * Generates KZG proofs for extracting bytes from EIP-4844 blobs.
 * Uses c-kzg-4844 library for cryptographic operations.
 */

// Node's CJS→ESM bridge treats c-kzg's `module.exports = { ... }` as a
// default export, not a flat namespace. `import *` leaves
// `cKzg.loadTrustedSetup` undefined at runtime; `import cKzg from`
// (under esModuleInterop) gives us the object directly.
import cKzg from 'c-kzg';
import { sha256 } from '@noble/hashes/sha2';
import type {
  Blob,
  BlobCommitment,
  ExtractedBytes,
  FieldElementRange,
  G1Point,
  KZGProof,
  KZGProofBatch,
  VersionedHash,
} from './types.js';
import type { Bytes32 } from '../types.js';
import {
  BYTES_PER_BLOB,
  BYTES_PER_FIELD_ELEMENT,
  FIELD_ELEMENTS_PER_BLOB,
  USABLE_BYTES_PER_BLOB,
  USABLE_BYTES_PER_FIELD_ELEMENT,
} from '../blob/constants.js';
import { assembleMultiSegmentBlob } from '../blob/multi-segment.js';

/** Zero contentTag used for the implicit single-segment in `createBlob`. */
const ZERO_TAG: Bytes32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as Bytes32;

/** Local alias preserved for module-internal readability. */
const USABLE_BYTES_PER_FE = USABLE_BYTES_PER_FIELD_ELEMENT;

/** Local alias preserved for compatibility with existing call sites. */
const BLOB_SIZE = BYTES_PER_BLOB;

/** Versioned hash prefix for KZG commitments */
const VERSIONED_HASH_PREFIX = 0x01;

/** Whether trusted setup has been loaded */
let setupLoaded = false;

/**
 * Load the KZG trusted setup
 * @param path Optional path to trusted setup file
 */
export function loadTrustedSetup(path?: string): void {
  if (setupLoaded) return;

  try {
    if (path) {
      cKzg.loadTrustedSetup(0, path);
    } else {
      // Use the mainnet trusted setup bundled with c-kzg
      cKzg.loadTrustedSetup(0);
    }
  } catch (e) {
    // c-kzg native state may already be loaded (e.g. dev server hot-reload)
    if (e instanceof Error && e.message.includes('already loaded')) {
      // safe to continue
    } else {
      throw e;
    }
  }
  setupLoaded = true;
}

/**
 * Ensure trusted setup is loaded
 */
function ensureSetupLoaded(): void {
  if (!setupLoaded) {
    throw new Error('KZG trusted setup not loaded. Call loadTrustedSetup() first.');
  }
}

/**
 * Compute the EIP-4844 versioned hash from a KZG commitment.
 *
 * Per EIP-4844 §3.1: `versioned_hash = VERSIONED_HASH_VERSION_KZG ‖
 * sha256(commitment)[1:]`. The first byte of `sha256(commitment)` is
 * replaced with the 0x01 version prefix; the remaining 31 bytes are
 * preserved as-is.
 */
export function computeVersionedHash(commitment: G1Point): VersionedHash {
  const hash = sha256(commitment);
  const versionedHash = new Uint8Array(32);
  versionedHash[0] = VERSIONED_HASH_PREFIX;
  versionedHash.set(hash.slice(1), 1);
  return ('0x' + Buffer.from(versionedHash).toString('hex')) as VersionedHash;
}

/**
 * Create a blob from data, padding as needed.
 *
 * One-segment shortcut over `assembleMultiSegmentBlob` so the single-tag
 * and multi-tag producer paths share one implementation. Output is
 * byte-identical to the previous standalone implementation.
 *
 * @param data Data to put in the blob (max ~127KB usable)
 * @returns Padded blob data
 */
export function createBlob(data: Uint8Array): Blob {
  const maxUsableBytes = USABLE_BYTES_PER_BLOB;
  if (data.length > maxUsableBytes) {
    throw new Error(`Data too large for blob: ${data.length} > ${maxUsableBytes}`);
  }

  const { blob } = assembleMultiSegmentBlob([
    { contentTag: ZERO_TAG, payload: data },
  ]);
  return blob;
}

/**
 * Commit to a blob and compute versioned hash
 * @param blob Blob data
 * @returns Commitment and versioned hash
 */
export function commitToBlob(blob: Blob): BlobCommitment {
  ensureSetupLoaded();

  if (blob.length !== BLOB_SIZE) {
    throw new Error(`Invalid blob size: ${blob.length} != ${BLOB_SIZE}`);
  }

  const commitment = cKzg.blobToKzgCommitment(blob) as G1Point;
  const versionedHash = computeVersionedHash(commitment);

  return { blob, commitment, versionedHash };
}

/**
 * Calculate which field elements are needed for a byte range
 * @param byteOffset Starting byte offset in blob
 * @param byteLength Number of bytes to extract
 * @returns Field element range
 */
export function calculateFieldElements(byteOffset: number, byteLength: number): FieldElementRange {
  const maxBytes = FIELD_ELEMENTS_PER_BLOB * USABLE_BYTES_PER_FE;
  if (byteOffset + byteLength > maxBytes) {
    throw new Error(`Byte range exceeds blob capacity: ${byteOffset + byteLength} > ${maxBytes}`);
  }

  const start = Math.floor(byteOffset / USABLE_BYTES_PER_FE);
  const end = Math.floor((byteOffset + byteLength - 1) / USABLE_BYTES_PER_FE);
  const count = end - start + 1;

  return { start, end, count };
}

/**
 * Generate KZG proof for a single field element
 * @param blob Blob data
 * @param commitment KZG commitment
 * @param fieldElementIndex Field element index (0-4095)
 * @returns KZG proof for the field element
 */
export function generateProofForFieldElement(
  blob: Blob,
  commitment: G1Point,
  fieldElementIndex: number
): KZGProof {
  ensureSetupLoaded();

  if (fieldElementIndex < 0 || fieldElementIndex >= FIELD_ELEMENTS_PER_BLOB) {
    throw new Error(`Field element index out of range: ${fieldElementIndex}`);
  }

  // Extract the field element value from the blob
  const feOffset = fieldElementIndex * BYTES_PER_FIELD_ELEMENT;
  const feBytes = blob.slice(feOffset, feOffset + BYTES_PER_FIELD_ELEMENT);

  // Convert to bigint (big-endian)
  const y = BigInt('0x' + Buffer.from(feBytes).toString('hex'));

  // The z value is the evaluation point (field element index)
  // In EIP-4844, z = omega^i where omega is the primitive root of unity
  // c-kzg handles this internally when given the index
  const z = BigInt(fieldElementIndex);

  // Generate the proof
  const proof = cKzg.computeBlobKzgProof(blob, commitment) as G1Point;

  return {
    z,
    y,
    commitment,
    proof,
  };
}

/**
 * Generate KZG proofs for extracting a byte range
 * @param blob Blob data
 * @param commitment KZG commitment
 * @param byteOffset Starting byte offset
 * @param byteLength Number of bytes to extract
 * @returns Batch of KZG proofs
 */
export function generateProofsForByteRange(
  blob: Blob,
  commitment: G1Point,
  byteOffset: number,
  byteLength: number
): KZGProofBatch {
  ensureSetupLoaded();

  const versionedHash = computeVersionedHash(commitment);
  const { start, end } = calculateFieldElements(byteOffset, byteLength);

  const proofs: KZGProof[] = [];
  for (let i = start; i <= end; i++) {
    proofs.push(generateProofForFieldElement(blob, commitment, i));
  }

  return {
    versionedHash,
    proofs,
    byteOffset,
    byteLength,
  };
}

/**
 * Extract bytes from a blob (without verification - for testing)
 * @param blob Blob data
 * @param byteOffset Starting byte offset
 * @param byteLength Number of bytes to extract
 * @returns Extracted bytes
 */
export function extractBytes(blob: Blob, byteOffset: number, byteLength: number): Uint8Array {
  const maxBytes = FIELD_ELEMENTS_PER_BLOB * USABLE_BYTES_PER_FE;
  if (byteOffset + byteLength > maxBytes) {
    throw new Error(`Byte range exceeds blob capacity`);
  }

  const result = new Uint8Array(byteLength);
  let dstOffset = 0;
  let remaining = byteLength;

  const { start, end } = calculateFieldElements(byteOffset, byteLength);
  const srcOffsetInFirstFE = byteOffset % USABLE_BYTES_PER_FE;

  for (let fe = start; fe <= end && remaining > 0; fe++) {
    const feOffset = fe * BYTES_PER_FIELD_ELEMENT;
    const feStartByte = fe === start ? srcOffsetInFirstFE : 0;
    const available = USABLE_BYTES_PER_FE - feStartByte;
    const toCopy = Math.min(available, remaining);

    // Extract from bytes 1-31 of the field element (byte 0 is padding)
    const srcStart = feOffset + 1 + feStartByte;
    result.set(blob.slice(srcStart, srcStart + toCopy), dstOffset);

    dstOffset += toCopy;
    remaining -= toCopy;
  }

  return result;
}

/**
 * Extract bytes with proof generation
 * @param blob Blob data
 * @param commitment KZG commitment
 * @param byteOffset Starting byte offset
 * @param byteLength Number of bytes to extract
 * @returns Extracted bytes with proofs
 */
export function extractBytesWithProofs(
  blob: Blob,
  commitment: G1Point,
  byteOffset: number,
  byteLength: number
): ExtractedBytes {
  const data = extractBytes(blob, byteOffset, byteLength);
  const fieldElements = calculateFieldElements(byteOffset, byteLength);
  const { proofs } = generateProofsForByteRange(blob, commitment, byteOffset, byteLength);

  return { data, fieldElements, proofs };
}

/**
 * Verify a KZG proof (for testing purposes)
 * Note: On-chain verification uses the point evaluation precompile
 * @param commitment KZG commitment
 * @param z Field element index
 * @param y Field element value
 * @param proof KZG proof
 * @returns True if proof is valid
 */
export function verifyProof(commitment: G1Point, z: bigint, y: bigint, proof: G1Point): boolean {
  ensureSetupLoaded();

  try {
    // c-kzg verification
    return cKzg.verifyKzgProof(commitment, bigintToBytes32(z), bigintToBytes32(y), proof);
  } catch {
    return false;
  }
}

/**
 * Convert bigint to 32-byte big-endian buffer
 */
function bigintToBytes32(value: bigint): Uint8Array {
  const hex = value.toString(16).padStart(64, '0');
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

/**
 * Convert 32-byte buffer to hex string
 */
export function toHex(bytes: Uint8Array): Bytes32 {
  return ('0x' + Buffer.from(bytes).toString('hex')) as Bytes32;
}

/**
 * Constants for external use.
 *
 * Sourced from `src/blob/constants.ts` (the single SDK source of truth);
 * kept as a stable named-export alias so existing consumers continue to
 * work.
 */
export const KZG_CONSTANTS = {
  FIELD_ELEMENTS_PER_BLOB,
  BYTES_PER_FIELD_ELEMENT,
  USABLE_BYTES_PER_FE: USABLE_BYTES_PER_FIELD_ELEMENT,
  BLOB_SIZE: BYTES_PER_BLOB,
  MAX_USABLE_BYTES: USABLE_BYTES_PER_BLOB,
} as const;
