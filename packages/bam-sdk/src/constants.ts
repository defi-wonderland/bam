/**
 * BAM Protocol Constants
 * @module bam-sdk/constants
 */

/** Magic number for individual messages: "SOBM" */
export const MAGIC_MESSAGE = 0x534f424d;

/** Magic number for compact batches: "SOB1" */
export const MAGIC_BATCH = 0x534f4231;

/** Magic number for exposure batches: "SOB2" */
export const MAGIC_EXPOSURE = 0x534f4232;

/** Current protocol version */
export const PROTOCOL_VERSION = 0x01;

/** Protocol version string */
export const PROTOCOL_VERSION_STRING = '0.1';

/** Maximum content length in characters */
export const MAX_CONTENT_CHARS = 280;

/** Maximum content length in bytes (4 bytes per char worst case) */
export const MAX_CONTENT_BYTES = 1120;

/** Maximum authors per batch */
export const MAX_AUTHORS_PER_BATCH = 256;

/** Maximum timestamp delta (2 bytes) */
export const MAX_TIMESTAMP_DELTA = 65535;

/** Maximum nonce value */
export const MAX_NONCE = 65535;

/** BLS signature size in bytes */
export const BLS_SIGNATURE_SIZE = 48;

/** ECDSA signature size in bytes */
export const ECDSA_SIGNATURE_SIZE = 65;

/** BLS public key size in bytes */
export const BLS_PUBKEY_SIZE = 96;

/** Ethereum address size in bytes */
export const ADDRESS_SIZE = 20;

/** Bytes32 size */
export const BYTES32_SIZE = 32;

/** Individual message header size (fixed portion) */
export const MESSAGE_HEADER_SIZE = 33;

/** Compact batch header fixed size (excluding author table) */
export const BATCH_HEADER_FIXED_SIZE = 95;

/** Exposure batch header fixed size: magic(4) + version(1) + flags(1) + msgCount(2) + blsSig(48) */
export const EXPOSURE_HEADER_SIZE = 56;

/** Exposure message length prefix size */
export const EXPOSURE_MSG_PREFIX_SIZE = 2;

/** Blob size limit in bytes */
export const BLOB_SIZE_LIMIT = 131072; // 128 KB

/** Usable blob capacity with 31-byte packing (4096 field elements * 31 usable bytes each).
 *  Must match KZG_CONSTANTS.MAX_USABLE_BYTES in kzg/proof-generator.ts. */
export const BLOB_USABLE_CAPACITY = 126976; // 4096 * 31

/** Zero bytes32 (no dictionary) */
export const ZERO_BYTES32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

/** Signature type values in flags byte */
export const SIG_TYPE_NONE = 0b00;
export const SIG_TYPE_ECDSA = 0b01;
export const SIG_TYPE_BLS = 0b10;
export const SIG_TYPE_EXTENDED = 0b11;

/** Extended signature header size (scheme ID + version) */
export const EXTENDED_SIG_HEADER_SIZE = 2;

/** Signature scheme IDs for extended mode */
export const SCHEME_ID_ECDSA = 0x01;
export const SCHEME_ID_BLS = 0x02;
export const SCHEME_ID_STARK = 0x03;
export const SCHEME_ID_DILITHIUM = 0x04;

/** Flag bit positions */
export const FLAG_SIGNATURE_MASK = 0b00000011;
export const FLAG_COMPRESSED = 0b00000100;
export const FLAG_REPLY = 0b00001000;
export const FLAG_EXTENDED_TIMESTAMP = 0b00010000;
export const FLAG_EXTENDED_CONTENT = 0b00100000;
export const FLAG_PK_REGISTRY = 0b00000010;

/** Batch flag bit positions */
export const BATCH_FLAG_SIGNATURE_MASK = 0b00000011;
export const BATCH_FLAG_COMPRESSED = 0b00000100;
export const BATCH_FLAG_PK_REGISTRY = 0b00010000;

/**
 * Compression codec identifiers.
 * Stored as a 1-byte field after the batch flags to identify the codec used.
 * The decoder reads this byte to determine how to decompress the payload.
 */
export const CODEC_NONE = 0x00;
export const CODEC_BPE = 0x01;
export const CODEC_ZSTD = 0x02;

/** BLS domain separator for message signing */
export const BLS_DOMAIN_PREFIX = 'SocialBlobs-v1';

/**
 * PoP domain tag for the ERC-8180 scheme-0x01 ECDSA registry.
 * Must match `POP_DOMAIN` in `ECDSARegistry.sol`.
 */
export const ECDSA_POP_DOMAIN = 'ERC-BAM-ECDSA-PoP.v1';

/** Default compression level for Zstd */
export const DEFAULT_COMPRESSION_LEVEL = 12;

/** Dictionary ID for built-in v1 dictionary */
export const DICTIONARY_V1_ID = 'v1';

/** Dictionary size in bytes (32 KB) */
export const DICTIONARY_SIZE = 32768;

/** SHA-256 hash of v1 dictionary for integrity verification */
export const DICTIONARY_V1_HASH =
  'd5d0dada5590f7958a506085759d5f13174c2a0baec762807f8d01d41e25ae62';

/**
 * Empirical compression metrics from Phase 003 benchmarking
 * Date: 2026-01-27
 * Corpus: 10,000 synthetic messages (98 chars average)
 */
export const COMPRESSION_METRICS = {
  /** Zstd level 12 with dictionary, batch size 100 (recommended production config) */
  recommended: {
    ratio: 9.17,
    compressionSpeedMbps: 77.18,
    decompressionSpeedMbps: 849.51,
    batchSize: 100,
    level: 12,
    hasDictionary: true,
  },
  /** Best case: Zstd level 19 with dictionary, batch size 1000 */
  best: {
    ratio: 16.56,
    compressionSpeedMbps: 21.52,
    decompressionSpeedMbps: 829.41,
    batchSize: 1000,
    level: 19,
    hasDictionary: true,
  },
  /** Without dictionary baseline: Zstd level 12, batch size 100 */
  noDictionary: {
    ratio: 4.62,
    compressionSpeedMbps: 107.2,
    decompressionSpeedMbps: 779.3,
    batchSize: 100,
    level: 12,
    hasDictionary: false,
  },
  /** Dictionary improvement factor (ratio with dict / ratio without dict) */
  dictionaryImprovement: 1.985, // 98.5% improvement (9.17x / 4.62x)
} as const;

/**
 * Empirical capacity metrics from Phase 003 capacity analysis
 * Date: 2026-01-27
 */
export const CAPACITY_METRICS = {
  /** Messages per blob (empirical scenario: 200 authors, 98 chars, 9.17x compression) */
  messagesPerBlob: 11543,
  /** Daily capacity with 6 blobs/block */
  dailyCapacity6Blobs: 498_657_600,
  /** Daily capacity with 14 blobs/block (near-term) */
  dailyCapacity14Blobs: 1_163_534_400,
  /** Daily capacity with 48 blobs/block (long-term) */
  dailyCapacity48Blobs: 3_989_260_800,
  /** Target batch size for optimal compression */
  targetBatchSize: 500,
  /** Minimum batch size for efficient compression */
  minimumBatchSize: 100,
} as const;
