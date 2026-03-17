/**
 * KZG Proof Types for BAM
 * @module bam-sdk/kzg/types
 */

import type { Bytes32 } from '../types.js';

/** 48-byte compressed G1 point (KZG commitment/proof) */
export type G1Point = Uint8Array;

/** Field element (32 bytes, big-endian) */
export type FieldElement = Uint8Array;

/** Blob data (131072 bytes = 4096 field elements * 32 bytes) */
export type Blob = Uint8Array;

/** Versioned hash (32 bytes, starts with 0x01) */
export type VersionedHash = Bytes32;

/**
 * KZG proof for a single field element
 */
export interface KZGProof {
  /** Field element index (0-4095) */
  z: bigint;
  /** Field element value */
  y: bigint;
  /** 48-byte KZG commitment */
  commitment: G1Point;
  /** 48-byte KZG proof */
  proof: G1Point;
}

/**
 * Batch of KZG proofs for extracting a byte range
 */
export interface KZGProofBatch {
  /** Versioned hash of the blob */
  versionedHash: VersionedHash;
  /** Array of proofs for required field elements */
  proofs: KZGProof[];
  /** Starting byte offset in blob */
  byteOffset: number;
  /** Number of bytes to extract */
  byteLength: number;
}

/**
 * Proof generation options
 */
export interface ProofOptions {
  /** Path to trusted setup file (uses default if not provided) */
  trustedSetupPath?: string;
}

/**
 * Blob commitment result
 */
export interface BlobCommitment {
  /** Blob data (131072 bytes) */
  blob: Blob;
  /** 48-byte KZG commitment */
  commitment: G1Point;
  /** Versioned hash (for EIP-4844) */
  versionedHash: VersionedHash;
}

/**
 * Field element range for proof generation
 */
export interface FieldElementRange {
  /** Start field element index (inclusive) */
  start: number;
  /** End field element index (inclusive) */
  end: number;
  /** Total count of field elements */
  count: number;
}

/**
 * Byte extraction result
 */
export interface ExtractedBytes {
  /** Extracted byte data */
  data: Uint8Array;
  /** Field elements used */
  fieldElements: FieldElementRange;
  /** Proofs for verification */
  proofs: KZGProof[];
}
