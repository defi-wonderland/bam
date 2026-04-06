/**
 * BAM SDK — Browser-safe entrypoint
 * @module bam-sdk/browser
 *
 * Re-exports everything from the main barrel EXCEPT modules that depend on
 * Node.js built-ins or native addons:
 * - kzg/ (c-kzg native module)
 * - compression-node (node:fs, node:crypto)
 * - exposure/blob-parser and exposure/builder (import from kzg/proof-generator)
 */

// Types
export type {
  Address,
  AggregatorInfo,
  Batch,
  BatchedMessage,
  BatchFlags,
  BatchHeader,
  BatchOptions,
  Bytes32,
  ClientOptions,
  DecodeBatchOptions,
  DecodedBatch,
  DictionaryInfo,
  EncodedBatch,
  EncodedMessage,
  ExtendedSignature,
  ExtendedSignatureHeader,
  HealthStatus,
  HexBytes,
  Message,
  MessageFlags,
  MessageStatus,
  MessageStatusResponse,
  SignatureType,
  SignedMessage,
  SubmitResult,
} from './types.js';

export { ErrorCode, SignatureScheme } from './types.js';

// Constants
export {
  ADDRESS_SIZE,
  BATCH_FLAG_COMPRESSED,
  BATCH_FLAG_PK_REGISTRY,
  BATCH_FLAG_SIGNATURE_MASK,
  BATCH_HEADER_FIXED_SIZE,
  BLS_DOMAIN_PREFIX,
  BLS_PUBKEY_SIZE,
  BLS_SIGNATURE_SIZE,
  BLOB_SIZE_LIMIT,
  BLOB_USABLE_CAPACITY,
  BYTES32_SIZE,
  DEFAULT_COMPRESSION_LEVEL,
  DICTIONARY_V1_ID,
  ECDSA_SIGNATURE_SIZE,
  FLAG_COMPRESSED,
  FLAG_EXTENDED_CONTENT,
  FLAG_EXTENDED_TIMESTAMP,
  FLAG_PK_REGISTRY,
  FLAG_REPLY,
  FLAG_SIGNATURE_MASK,
  MAGIC_BATCH,
  MAGIC_MESSAGE,
  MAX_AUTHORS_PER_BATCH,
  MAX_CONTENT_BYTES,
  MAX_CONTENT_CHARS,
  MAX_NONCE,
  MAX_TIMESTAMP_DELTA,
  MESSAGE_HEADER_SIZE,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_STRING,
  SCHEME_ID_BLS,
  SCHEME_ID_DILITHIUM,
  SCHEME_ID_ECDSA,
  SCHEME_ID_STARK,
  SIG_TYPE_BLS,
  SIG_TYPE_ECDSA,
  SIG_TYPE_EXTENDED,
  SIG_TYPE_NONE,
  EXTENDED_SIG_HEADER_SIZE,
  ZERO_BYTES32,
} from './constants.js';

// Errors
export {
  AuthorIndexError,
  AuthorNotFoundError,
  BatchOverflowError,
  BatchTruncatedError,
  ContentTooLongError,
  DecompressionError,
  InvalidFlagsError,
  InvalidMagicError,
  InvalidUtf8Error,
  SignatureError,
  BAMError,
  TimestampOverflowError,
  TooManyAuthorsError,
  UnknownSignatureSchemeError,
  UnsupportedSchemeVersionError,
  UnsupportedVersionError,
} from './errors.js';

// Message functions
export {
  bytesToHex,
  computeMessageHash,
  computeMessageId,
  decodeMessage,
  encodeExtendedHeader,
  encodeMessage,
  encodeMessageWithId,
  getSignatureSizeForScheme,
  hexToBytes,
  parseExtendedHeader,
} from './message.js';
export type { EncodeMessageOptions } from './message.js';

// Compression functions (browser-safe only — no loadBundledDictionary/loadDictionaryFromFile)
export {
  compress,
  compressionRatio,
  decompress,
  getDecompressedSize,
  isCompressed,
  loadDictionary,
} from './compression.js';

export type { ZstdDictionary } from './compression.js';

// Batch functions
export {
  buildAuthorTable,
  decodeBatch,
  encodeBatch,
  estimateBatchSize,
  validateBatch,
} from './batch.js';

// Signature functions
export {
  aggregateBLS,
  deriveAddress,
  deriveBLSPublicKey,
  deserializeBLSPrivateKey,
  deserializeBLSPublicKey,
  deserializeBLSSignature,
  deserializeECDSASignature,
  generateBLSPrivateKey,
  generateECDSAPrivateKey,
  isValidBLSPrivateKey,
  isValidBLSPublicKey,
  isValidBLSSignature,
  isValidECDSASignature,
  recoverAddress,
  serializeBLSPrivateKey,
  serializeBLSPublicKey,
  serializeBLSSignature,
  serializeECDSASignature,
  signBLS,
  signECDSA,
  verifyAggregateBLS,
  verifyBLS,
  verifyECDSA,
} from './signatures.js';

export type {
  BLSPrivateKey,
  BLSPublicKey,
  BLSSignature,
  ECDSAPrivateKey,
  ECDSASignature,
} from './signatures.js';

// Aggregator client
export { AggregatorClient, AggregatorClientError } from './aggregator-client.js';

export type { AggregatorClientOptions } from './aggregator-client.js';

// Exposure types only (no blob-parser or builder — they depend on kzg)
export type {
  ParsedBlob,
  ParsedMessage,
  ParseBlobOptions,
  ExposureParams,
  ExposureResult,
  BlobRegistrationResult,
  CalldataRegistrationResult,
  CalldataExposureParams,
} from './exposure/types.js';

// Contract client (uses viem, browser-safe)
export * from './contracts/index.js';
