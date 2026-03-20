/**
 * BAM Protocol Type Definitions
 * @module bam-sdk/types
 */

/** Ethereum address (20 bytes) */
export type Address = `0x${string}`;

/** 32-byte hash (keccak256 result) */
export type Bytes32 = `0x${string}`;

/** Variable-length hex-encoded bytes */
export type HexBytes = `0x${string}`;

/** Signature type enumeration (v1 wire format) */
export type SignatureType = 'bls' | 'ecdsa' | 'extended';

/**
 * Signature scheme identifiers for extended mode (SigType 11)
 * @see docs/specs/008-signature-extensibility
 */
export enum SignatureScheme {
  /** ECDSA secp256k1 (Ethereum native) */
  ECDSA = 0x01,
  /** BLS12-381 (aggregatable) */
  BLS = 0x02,
  /** STARK-Poseidon (v2, post-quantum) */
  STARK = 0x03,
  /** Dilithium (NIST PQC standard) */
  Dilithium = 0x04,
}

/**
 * Extended signature header (when SigType = 11)
 * Enables future signature schemes without protocol changes
 */
export interface ExtendedSignatureHeader {
  /** Signature scheme identifier (1 byte) */
  scheme: SignatureScheme;
  /** Scheme version for forward compatibility (1 byte) */
  schemeVersion: number;
}

/**
 * Extended signature data (SigType 11)
 */
export interface ExtendedSignature {
  /** Extended header */
  header: ExtendedSignatureHeader;
  /** Signature bytes (format depends on scheme) */
  signature: Uint8Array;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ERC-BAM TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Decoded message from an IERC_BAM_Decoder
 * Matches the on-chain Message struct: {address sender, uint64 nonce, bytes contents}
 */
export interface BAMMessage {
  /** Message sender's Ethereum address */
  sender: Address;
  /** Per-sender sequential nonce */
  nonce: bigint;
  /** Raw message contents */
  contents: Uint8Array;
}

/**
 * ERC-BAM hash types used in the decode → hash → verify flow.
 *
 * messageHash: keccak256(sender || nonce || contents) — security bridge
 * messageId:   keccak256(author || nonce || contentHash) — deduplication key
 * signedHash:  keccak256(domain || messageHash) — cross-chain replay prevention
 *
 * The domain separator keccak256("ERC-BAM.v1" || chainId) is used to compute signedHash
 * but is not included as a field — it is derived from the chain context.
 */
export interface BAMHashes {
  /** keccak256(abi.encodePacked(sender, nonce, contents)) */
  messageHash: Bytes32;
  /** keccak256(abi.encodePacked(author, nonce, contentHash)) */
  messageId: Bytes32;
  /** keccak256(abi.encodePacked(domain, messageHash)) */
  signedHash: Bytes32;
}

/**
 * BlobBatchRegistered event data (from IERC_BAM_Core)
 */
export interface BlobBatchRegisteredEvent {
  /** EIP-4844 versioned hash of the blob */
  versionedHash: Bytes32;
  /** Address that registered the batch */
  submitter: Address;
  /** Decoder contract address */
  decoder: Address;
  /** Signature registry address */
  signatureRegistry: Address;
}

/**
 * CalldataBatchRegistered event data (from IERC_BAM_Core)
 */
export interface CalldataBatchRegisteredEvent {
  /** keccak256 of batch data */
  contentHash: Bytes32;
  /** Address that registered the batch */
  submitter: Address;
  /** Decoder contract address */
  decoder: Address;
  /** Signature registry address */
  signatureRegistry: Address;
}

/**
 * MessageExposed event data (from IERC_BAM_Exposer)
 */
export interface MessageExposedEvent {
  /** Content identifier (versioned hash for blob, keccak256 for calldata) */
  contentHash: Bytes32;
  /** Unique message identifier: keccak256(author || nonce || contentHash) */
  messageId: Bytes32;
  /** Author's Ethereum address */
  author: Address;
  /** Address that called the expose function */
  exposer: Address;
  /** Block timestamp when exposed */
  timestamp: bigint;
}

/** Message status in aggregator pipeline */
export type MessageStatus =
  | 'pending'
  | 'batched'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'expired';

/**
 * Individual message (standalone format)
 * Used for direct submission, archival storage, and debugging
 */
export interface Message {
  /** Message author's Ethereum address */
  author: Address;
  /** Unix epoch timestamp in seconds */
  timestamp: number;
  /** Per-author sequential counter (0-65535) */
  nonce: number;
  /** UTF-8 message content (max 280 characters) */
  content: string;
  /** Signature bytes (48 for BLS, 65 for ECDSA) */
  signature?: Uint8Array;
  /** Signature algorithm type */
  signatureType?: SignatureType;
  /** Optional reply-to message ID */
  replyTo?: Bytes32;
}

/**
 * Signed message ready for submission
 */
export interface SignedMessage extends Message {
  signature: Uint8Array;
  signatureType: SignatureType;
  /** Extended header for SigType 11 (extended mode) */
  extendedHeader?: ExtendedSignatureHeader;
}

/**
 * Batched message (within batch context)
 * References batch header for shared data
 */
export interface BatchedMessage {
  /** Index into batch author table (0-255) */
  authorIndex: number;
  /** Seconds offset from batch base timestamp (0-65535) */
  timestampDelta: number;
  /** Per-author sequential counter (0-65535) */
  nonce: number;
  /** UTF-8 message content */
  content: string;
  /** BLS public key registry index (0-16777215) */
  pkRegistryIndex?: number;
  /** Optional reply-to message ID */
  replyTo?: Bytes32;
}

/**
 * Batch header containing shared metadata
 */
export interface BatchHeader {
  /** Protocol version string (e.g., "0.1") */
  version: string;
  /** Compression dictionary reference (32 bytes) */
  dictionaryRef: Bytes32;
  /** Base timestamp for delta encoding */
  baseTimestamp: number;
  /** Author address lookup table */
  authors: Address[];
  /** BLS aggregate signature (48 bytes) */
  aggregateSignature: Uint8Array;
}

/**
 * Complete batch structure
 */
export interface Batch {
  /** Batch header with metadata */
  header: BatchHeader;
  /** Array of batched messages */
  messages: BatchedMessage[];
}

/** Compression codec type */
export type CompressionCodec = 'none' | 'bpe' | 'zstd';

/**
 * Batch encoding options
 */
export interface BatchOptions {
  /** Compression codec to use (default 'none') */
  codec?: CompressionCodec;
  /** Compression dictionary bytes (Zstd raw dict for 'zstd', serialized BPE dict for 'bpe') */
  dictionary?: Uint8Array;
  /** Compression level (1-22, default 12) — only used with 'zstd' codec */
  compressionLevel?: number;
  /** @deprecated Use codec instead. Whether to compress (default true) */
  compress?: boolean;
}

/**
 * Message flags byte structure
 */
export interface MessageFlags {
  /** Signature type (0=none, 1=ECDSA, 2=BLS, 3=extended) */
  signatureType: 0 | 1 | 2 | 3;
  /** Content is compressed */
  compressed: boolean;
  /** Contains reply reference */
  hasReply: boolean;
}

/**
 * Batch flags byte structure
 */
export interface BatchFlags {
  /** Signature aggregation type (0=none, 1=ECDSA, 2=BLS, 3=extended) */
  signatureType: 0 | 1 | 2 | 3;
  /** Compression enabled */
  compressed: boolean;
  /** Messages include PK registry indices */
  hasPkRegistryIndices: boolean;
}

/**
 * Decoded batch result
 */
export interface DecodedBatch {
  /** Batch header */
  header: BatchHeader;
  /** Decoded messages with resolved authors */
  messages: Message[];
  /** Original compressed size */
  compressedSize: number;
  /** Decompressed size */
  decompressedSize: number;
  /** Byte offset where batch starts in the blob (0 if at start) */
  batchStartOffset?: number;
}

/**
 * Options for decoding a batch
 */
export interface DecodeBatchOptions {
  /** Byte offset where the batch starts in the blob (default: 0) */
  batchStartOffset?: number;
}

/**
 * Message encoding result
 */
export interface EncodedMessage {
  /** Encoded binary data */
  data: Uint8Array;
  /** Computed message ID */
  messageId: Bytes32;
  /** Total byte size */
  size: number;
}

/**
 * Batch encoding result
 */
export interface EncodedBatch {
  /** Encoded binary data */
  data: Uint8Array;
  /** Header size in bytes */
  headerSize: number;
  /** Compressed data size */
  compressedSize: number;
  /** Total size in bytes */
  totalSize: number;
  /** Number of messages */
  messageCount: number;
  /** Number of unique authors */
  authorCount: number;
  /** Compression ratio achieved */
  compressionRatio: number;
}

/**
 * Aggregator client options
 */
export interface ClientOptions {
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Custom headers */
  headers?: Record<string, string>;
  /** Retry configuration */
  retry?: {
    /** Maximum retry attempts */
    maxAttempts: number;
    /** Base delay between retries in ms */
    baseDelay: number;
  };
}

/**
 * Aggregator health status
 */
export interface HealthStatus {
  /** Whether aggregator is healthy */
  healthy: boolean;
  /** Protocol version supported */
  version: string;
  /** Current queue depth */
  queueDepth: number;
  /** Estimated time to next batch (seconds) */
  estimatedBatchTime: number;
}

/**
 * Aggregator info response
 */
export interface AggregatorInfo {
  /** Aggregator name */
  name: string;
  /** Supported protocol versions */
  versions: string[];
  /** Supported compression dictionaries */
  dictionaries: DictionaryInfo[];
  /** Rate limits */
  rateLimits: {
    /** Messages per minute */
    messagesPerMinute: number;
    /** Messages per hour */
    messagesPerHour: number;
  };
  /** Aggregator's Ethereum address */
  address: Address;
}

/**
 * Dictionary metadata
 */
export interface DictionaryInfo {
  /** Dictionary identifier */
  id: string;
  /** Dictionary reference (IPFS CID or blob hash) */
  ref: Bytes32;
  /** Dictionary size in bytes */
  size: number;
  /** Whether this is the default dictionary */
  default: boolean;
}

/**
 * Message submission result
 */
export interface SubmitResult {
  /** Assigned message ID */
  messageId: Bytes32;
  /** Current status */
  status: MessageStatus;
  /** Estimated inclusion time (seconds) */
  estimatedInclusionTime?: number;
}

/**
 * Message status response
 */
export interface MessageStatusResponse {
  /** Message ID */
  messageId: Bytes32;
  /** Current status */
  status: MessageStatus;
  /** Blob transaction hash (if submitted/confirmed) */
  blobTxHash?: Bytes32;
  /** Block number (if confirmed) */
  blockNumber?: number;
  /** Batch index within blob */
  batchIndex?: number;
  /** Message index within batch */
  messageIndex?: number;
  /** Error message (if failed) */
  error?: string;
}

/**
 * Protocol error codes
 */
export enum ErrorCode {
  INVALID_MAGIC = 'E001',
  UNSUPPORTED_VERSION = 'E002',
  INVALID_FLAGS = 'E003',
  AUTHOR_INDEX_OOB = 'E004',
  TIMESTAMP_OVERFLOW = 'E005',
  CONTENT_TOO_LONG = 'E006',
  INVALID_UTF8 = 'E007',
  DECOMPRESSION_FAILED = 'E008',
  SIGNATURE_INVALID = 'E009',
  BATCH_TRUNCATED = 'E010',
  BATCH_OVERFLOW = 'E011',
  UNKNOWN_SIGNATURE_SCHEME = 'E012',
  UNSUPPORTED_SCHEME_VERSION = 'E013',
  TOO_MANY_AUTHORS = 'E014',
  AUTHOR_NOT_FOUND = 'E015',
}
