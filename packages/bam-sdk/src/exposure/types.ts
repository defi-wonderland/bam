/**
 * Exposure Types for BAM
 * @module bam-sdk/exposure/types
 */

import type { Address, Bytes32, HexBytes } from '../types.js';
import type { KZGProof, VersionedHash } from '../kzg/types.js';

/**
 * Parsed message from a blob with position info
 */
export interface ParsedMessage {
  /** Message author's Ethereum address */
  author: Address;
  /** Unix timestamp */
  timestamp: number;
  /** Per-author nonce */
  nonce: number;
  /** Message content */
  content: string;
  /** Byte offset relative to batch start */
  byteOffset: number;
  /** Absolute byte offset in the blob (for KZG proofs) */
  absoluteByteOffset: number;
  /** Message length in bytes */
  byteLength: number;
  /** Index within the blob/batch */
  messageIndex: number;
  /** Raw message bytes */
  rawBytes: Uint8Array;
  /** Message hash (keccak256) */
  messageHash: Bytes32;
}

/**
 * Parsed blob containing messages
 */
export interface ParsedBlob {
  /** Versioned hash of the blob */
  versionedHash: VersionedHash;
  /** Block number where blob was submitted */
  blockNumber?: number;
  /** Parsed messages */
  messages: ParsedMessage[];
  /** Total message count */
  messageCount: number;
  /** Whether blob is compressed */
  compressed: boolean;
  /** Dictionary hash (if compressed) */
  dictionaryHash?: Bytes32;
  /** Byte offset where batch starts in the blob */
  batchStartOffset: number;
}

/**
 * Options for parsing a blob
 */
export interface ParseBlobOptions {
  /** Byte offset where the batch starts in the blob (default: 0) */
  batchStartOffset?: number;
  /** Versioned hash (computed if not provided) */
  versionedHash?: VersionedHash;
}

/**
 * Exposure parameters for on-chain transaction
 */
export interface ExposureParams {
  /** EIP-4844 versioned hash of the blob */
  versionedHash: Bytes32;
  /** Array of KZG proofs */
  kzgProofs: KZGProof[];
  /** Byte offset where batch starts in the blob (default: 0) */
  batchStartOffset: number;
  /** Byte offset of message relative to batch start */
  byteOffset: number;
  /** Message length */
  byteLength: number;
  /** Raw message bytes */
  messageBytes: Uint8Array;
  /** BLS signature (96 bytes) */
  blsSignature: Uint8Array;
  /** Registration proof (empty for SimpleBoolVerifier) */
  registrationProof: Uint8Array;
}

/**
 * Exposure transaction result
 */
export interface ExposureResult {
  /** Transaction hash */
  txHash: Bytes32;
  /** Message hash (returned by contract) */
  messageHash: Bytes32;
  /** Block number */
  blockNumber: number;
  /** Gas used */
  gasUsed: bigint;
}

/**
 * Blob registration result
 */
export interface BlobRegistrationResult {
  /** Transaction hash */
  txHash: Bytes32;
  /** Versioned hash */
  versionedHash: VersionedHash;
  /**
   * Protocol/content identifier parsed from the `BlobBatchRegistered` event (indexed
   * topic). Equal to the `contentTag` argument the caller passed to `registerBlobBatch`.
   * Undefined for legacy `registerBlob` (SocialBlobsCore), which does not emit a tag.
   */
  contentTag?: Bytes32;
  /** Block number */
  blockNumber: number;
}

/**
 * Calldata registration result
 */
export interface CalldataRegistrationResult {
  /** Transaction hash */
  txHash: Bytes32;
  /** Content hash (keccak256 of batch data) */
  contentHash: Bytes32;
  /**
   * Protocol/content identifier parsed from the `CalldataBatchRegistered` event
   * (indexed topic). Equal to the `contentTag` argument the caller passed to
   * `registerCalldataBatch`. Undefined for legacy `registerCalldata`
   * (SocialBlobsCore), which does not emit a tag.
   */
  contentTag?: Bytes32;
  /** Block number */
  blockNumber: number;
  /** Gas used */
  gasUsed: bigint;
}

/**
 * Exposure parameters for calldata batches (no KZG proofs needed)
 */
export interface CalldataExposureParams {
  /** Full batch data (for hash verification) */
  batchData: Uint8Array;
  /** Byte offset of message within batch */
  messageOffset: number;
  /** Raw message bytes */
  messageBytes: Uint8Array;
  /** Signature (BLS or ECDSA) */
  signature: Uint8Array;
  /** Registration proof (empty for SimpleBoolVerifier) */
  registrationProof: Uint8Array;
}

/**
 * Encoded exposure batch result
 */
export interface ExposureBatch {
  /** Encoded batch data (header + length-prefixed raw messages) */
  data: Uint8Array;
  /** Header size in bytes */
  headerSize: number;
  /** Total size in bytes */
  totalSize: number;
  /** Number of messages */
  messageCount: number;
  /** Per-message byte offsets relative to batch start (pointing to rawBytes, past length prefix) */
  messageOffsets: number[];
  /** Per-message rawBytes lengths */
  messageLengths: number[];
}

/**
 * Decoded exposure batch
 */
export interface DecodedExposureBatch {
  /** Decoded messages */
  messages: Array<{
    author: Address;
    timestamp: number;
    nonce: number;
    content: string;
    rawBytes: Uint8Array;
  }>;
  /** Message count */
  messageCount: number;
  /** Aggregate BLS signature (48 bytes, or zeros if not present) */
  aggregateSignature: Uint8Array;
  /** Whether aggregate signature is present */
  hasAggregateSignature: boolean;
}

/**
 * Exposure builder options
 */
export interface ExposureBuilderOptions {
  /** RPC URL for Ethereum node */
  rpcUrl: string;
  /** SocialBlobsCore contract address */
  coreContract: Address;
  /** BLSRegistry contract address */
  blsRegistry: Address;
  /** Private key for signing (optional, for tx submission) */
  privateKey?: HexBytes;
}
