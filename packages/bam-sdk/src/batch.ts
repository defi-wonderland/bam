/**
 * BAM Batch Encoding/Decoding
 * @module bam-sdk/batch
 */

import type {
  Address,
  BatchHeader,
  BatchOptions,
  Bytes32,
  DecodeBatchOptions,
  DecodedBatch,
  EncodedBatch,
  Message,
  SignedMessage,
} from './types.js';
import {
  ADDRESS_SIZE,
  BATCH_FLAG_COMPRESSED,
  BATCH_HEADER_FIXED_SIZE,
  BLS_SIGNATURE_SIZE,
  BLOB_SIZE_LIMIT,
  BYTES32_SIZE,
  MAGIC_BATCH,
  MAX_AUTHORS_PER_BATCH,
  MAX_TIMESTAMP_DELTA,
  PROTOCOL_VERSION,
  SIG_TYPE_BLS,
  ZERO_BYTES32,
} from './constants.js';
import {
  AuthorIndexError,
  AuthorNotFoundError,
  BatchOverflowError,
  BatchTruncatedError,
  InvalidFlagsError,
  InvalidMagicError,
  TimestampOverflowError,
  TooManyAuthorsError,
  UnsupportedVersionError,
} from './errors.js';
import { compress, decompress, loadDictionary, type ZstdDictionary } from './compression.js';
import { hexToBytes, bytesToHex } from './message.js';
import { keccak_256 } from '@noble/hashes/sha3';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Build author table from messages
 * Extracts unique authors and assigns indices
 * @param messages Messages to extract authors from
 * @returns Array of unique author addresses
 */
export function buildAuthorTable(messages: Message[]): Address[] {
  const authorSet = new Set<string>();

  for (const msg of messages) {
    authorSet.add(msg.author.toLowerCase());
  }

  const authors = Array.from(authorSet).sort() as Address[];

  if (authors.length > MAX_AUTHORS_PER_BATCH) {
    throw new TooManyAuthorsError(authors.length, MAX_AUTHORS_PER_BATCH);
  }

  return authors;
}

/**
 * Get author index in table
 * @param author Author address
 * @param authorTable Author table
 * @returns Index in table (0-255)
 */
function getAuthorIndex(author: Address, authorTable: Address[]): number {
  const index = authorTable.findIndex((addr) => addr.toLowerCase() === author.toLowerCase());

  if (index === -1) {
    throw new AuthorNotFoundError(author);
  }

  return index;
}

/**
 * Calculate base timestamp for batch
 * Uses the minimum timestamp from all messages
 * @param messages Messages to analyze
 * @returns Base timestamp
 */
function calculateBaseTimestamp(messages: Message[]): number {
  if (messages.length === 0) {
    return Math.floor(Date.now() / 1000);
  }

  return Math.min(...messages.map((m) => m.timestamp));
}

/**
 * Encode batch header
 * @param header Batch header
 * @returns Encoded header bytes
 */
function encodeBatchHeader(header: BatchHeader): Uint8Array {
  const authorTableSize = header.authors.length * ADDRESS_SIZE;
  const headerSize = BATCH_HEADER_FIXED_SIZE + authorTableSize;

  const buffer = new ArrayBuffer(headerSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let offset = 0;

  // Magic (4 bytes, big-endian)
  view.setUint32(offset, MAGIC_BATCH, false);
  offset += 4;

  // Version (1 byte)
  view.setUint8(offset, PROTOCOL_VERSION);
  offset += 1;

  // Flags (1 byte) - will be set by caller
  view.setUint8(offset, 0); // Placeholder
  offset += 1;

  // Dictionary reference (32 bytes)
  const dictRefBytes = hexToBytes(header.dictionaryRef);
  bytes.set(dictRefBytes, offset);
  offset += BYTES32_SIZE;

  // Base timestamp (4 bytes, big-endian)
  view.setUint32(offset, header.baseTimestamp, false);
  offset += 4;

  // Author count (2 bytes, big-endian)
  view.setUint16(offset, header.authors.length, false);
  offset += 2;

  // Author table
  for (const author of header.authors) {
    const authorBytes = hexToBytes(author);
    if (authorBytes.length !== ADDRESS_SIZE) {
      throw new Error(
        `Invalid author address length: ${authorBytes.length} (expected ${ADDRESS_SIZE}) for ${author}`
      );
    }
    bytes.set(authorBytes, offset);
    offset += ADDRESS_SIZE;
  }

  // Message count (2 bytes, big-endian) - placeholder, will be set by caller
  view.setUint16(offset, 0, false);
  offset += 2;

  // BLS aggregate signature (48 bytes)
  bytes.set(header.aggregateSignature, offset);
  offset += BLS_SIGNATURE_SIZE;

  return bytes;
}

/**
 * Encode a batched message
 * @param msg Message to encode
 * @param authorTable Author table for index lookup
 * @param baseTimestamp Base timestamp for delta encoding
 * @returns Encoded message bytes
 */
function encodeBatchedMessage(
  msg: Message,
  authorTable: Address[],
  baseTimestamp: number
): Uint8Array {
  const contentBytes = textEncoder.encode(msg.content);

  // Calculate timestamp delta
  const timestampDelta = msg.timestamp - baseTimestamp;
  if (timestampDelta < 0) {
    throw new TimestampOverflowError(timestampDelta, 0);
  }
  if (timestampDelta > MAX_TIMESTAMP_DELTA) {
    throw new TimestampOverflowError(timestampDelta, MAX_TIMESTAMP_DELTA);
  }

  // Get author index
  const authorIndex = getAuthorIndex(msg.author, authorTable);

  // Calculate size
  const hasPkRegistry = false; // For now, not implemented
  const hasReply = !!msg.replyTo;
  const replySize = hasReply ? BYTES32_SIZE : 0;
  const pkRegistrySize = hasPkRegistry ? 3 : 0;

  const totalSize = 1 + 2 + 2 + 1 + 1 + contentBytes.length + replySize + pkRegistrySize;

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let offset = 0;

  // Author index (1 byte)
  view.setUint8(offset, authorIndex);
  offset += 1;

  // Timestamp delta (2 bytes, big-endian)
  view.setUint16(offset, timestampDelta, false);
  offset += 2;

  // Nonce (2 bytes, big-endian)
  view.setUint16(offset, msg.nonce, false);
  offset += 2;

  // Flags (1 byte)
  let flags = 0;
  if (hasReply) flags |= 0x08; // Reply flag
  if (hasPkRegistry) flags |= 0x02; // PK registry flag
  view.setUint8(offset, flags);
  offset += 1;

  // Content length (1 byte)
  view.setUint8(offset, contentBytes.length);
  offset += 1;

  // Content
  bytes.set(contentBytes, offset);
  offset += contentBytes.length;

  // Reply-to (optional, 32 bytes)
  if (hasReply && msg.replyTo) {
    const replyBytes = hexToBytes(msg.replyTo);
    bytes.set(replyBytes, offset);
    offset += BYTES32_SIZE;
  }

  // PK registry index (optional, 3 bytes)
  // Not implemented yet

  return bytes;
}

/**
 * Encode messages into a batch
 * @param messages Messages to batch
 * @param options Batch options (dictionary, compression level)
 * @returns Encoded batch
 */
export function encodeBatch(messages: SignedMessage[], options?: BatchOptions): EncodedBatch {
  if (messages.length === 0) {
    throw new Error('Cannot create empty batch');
  }

  // Build author table
  const authorTable = buildAuthorTable(messages);

  // Calculate base timestamp
  const baseTimestamp = calculateBaseTimestamp(messages);

  // Create aggregate signature (placeholder - all zeros for now)
  // In production, this would aggregate all BLS signatures
  const aggregateSignature = new Uint8Array(BLS_SIGNATURE_SIZE).fill(0);

  // Build batch header
  const header: BatchHeader = {
    version: '0.1',
    dictionaryRef: options?.dictionary
      ? (bytesToHex(keccak_256(options.dictionary)) as Bytes32)
      : ZERO_BYTES32,
    baseTimestamp,
    authors: authorTable,
    aggregateSignature,
  };

  // Encode header
  const headerBytes = encodeBatchHeader(header);

  // Encode all messages
  const messageBytesList: Uint8Array[] = [];
  for (const msg of messages) {
    const msgBytes = encodeBatchedMessage(msg, authorTable, baseTimestamp);
    messageBytesList.push(msgBytes);
  }

  // Concatenate all message bytes
  const uncompressedSize = messageBytesList.reduce((sum, bytes) => sum + bytes.length, 0);
  const uncompressedMessages = new Uint8Array(uncompressedSize);
  let offset = 0;
  for (const msgBytes of messageBytesList) {
    uncompressedMessages.set(msgBytes, offset);
    offset += msgBytes.length;
  }

  // Compress if requested
  const shouldCompress = options?.compress !== false;
  let compressedData: Uint8Array;
  let compressionRatio: number;

  if (shouldCompress && options?.dictionary) {
    // Convert Uint8Array to ZstdDictionary
    const dict = loadDictionary(options.dictionary);
    compressedData = compress(uncompressedMessages, dict, options.compressionLevel);
    compressionRatio = uncompressedSize / compressedData.length;
  } else {
    compressedData = uncompressedMessages;
    compressionRatio = 1.0;
  }

  // Build final batch
  const compressedLenSize = 4;
  const totalSize = headerBytes.length + compressedLenSize + compressedData.length;

  // Check blob size limit
  if (totalSize > BLOB_SIZE_LIMIT) {
    throw new BatchOverflowError(totalSize, BLOB_SIZE_LIMIT);
  }

  const batchBuffer = new Uint8Array(totalSize);
  const batchView = new DataView(batchBuffer.buffer);
  offset = 0;

  // Copy header
  batchBuffer.set(headerBytes, offset);

  // Update flags in header
  let flags = SIG_TYPE_BLS; // BLS aggregate signature
  if (shouldCompress && options?.dictionary) {
    flags |= BATCH_FLAG_COMPRESSED;
  }
  batchBuffer[5] = flags; // Flags byte at offset 5

  // Update message count in header
  // Offset: 4 magic + 1 version + 1 flags + 32 dict + 4 timestamp + 2 authorCount + (N * 20) authors
  const msgCountOffset = 44 + authorTable.length * ADDRESS_SIZE;
  batchView.setUint16(msgCountOffset, messages.length, false);

  offset = headerBytes.length;

  // Compressed data length (4 bytes)
  batchView.setUint32(offset, compressedData.length, false);
  offset += 4;

  // Compressed data
  batchBuffer.set(compressedData, offset);

  return {
    data: batchBuffer,
    headerSize: headerBytes.length,
    compressedSize: compressedData.length,
    totalSize,
    messageCount: messages.length,
    authorCount: authorTable.length,
    compressionRatio,
  };
}

/**
 * Decode batch header
 * @param data Batch data
 * @returns Decoded header and offset to compressed data
 */
function decodeBatchHeader(data: Uint8Array): {
  header: BatchHeader;
  offset: number;
} {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  // Magic (4 bytes)
  const magic = view.getUint32(offset, false);
  if (magic !== MAGIC_BATCH) {
    throw new InvalidMagicError(MAGIC_BATCH, magic);
  }
  offset += 4;

  // Version (1 byte)
  const version = view.getUint8(offset);
  if (version !== PROTOCOL_VERSION) {
    throw new UnsupportedVersionError(version);
  }
  offset += 1;

  // Flags (1 byte)
  const flags = view.getUint8(offset);
  offset += 1;

  // Validate reserved bits
  if (flags & 0b11100000) {
    throw new InvalidFlagsError(flags, 'Reserved bits must be zero');
  }

  // Dictionary reference (32 bytes)
  const dictionaryRef = bytesToHex(data.slice(offset, offset + BYTES32_SIZE)) as `0x${string}`;
  offset += BYTES32_SIZE;

  // Base timestamp (4 bytes)
  const baseTimestamp = view.getUint32(offset, false);
  offset += 4;

  // Author count (2 bytes)
  const authorCount = view.getUint16(offset, false);
  offset += 2;

  // Author table
  const authors: Address[] = [];
  for (let i = 0; i < authorCount; i++) {
    // Create a clean copy of the address bytes
    const authorBytes = new Uint8Array(ADDRESS_SIZE);
    for (let j = 0; j < ADDRESS_SIZE; j++) {
      authorBytes[j] = data[offset + j];
    }
    const author = bytesToHex(authorBytes) as Address;
    authors.push(author);
    offset += ADDRESS_SIZE;
  }

  // Message count (2 bytes) - stored but not used in header
  // const messageCount = view.getUint16(offset, false);
  offset += 2;

  // BLS aggregate signature (48 bytes)
  const aggregateSignature = data.slice(offset, offset + BLS_SIGNATURE_SIZE);
  offset += BLS_SIGNATURE_SIZE;

  const header: BatchHeader = {
    version: '0.1',
    dictionaryRef,
    baseTimestamp,
    authors,
    aggregateSignature,
  };

  return { header, offset };
}

/**
 * Decode a batched message
 * @param data Message data
 * @param offset Starting offset
 * @param authorTable Author table for address lookup
 * @param baseTimestamp Base timestamp for reconstructing absolute timestamp
 * @returns Decoded message and new offset
 */
function decodeBatchedMessage(
  data: Uint8Array,
  offset: number,
  authorTable: Address[],
  baseTimestamp: number
): { message: Message; offset: number } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // Author index (1 byte)
  const authorIndex = view.getUint8(offset);
  if (authorIndex >= authorTable.length) {
    throw new AuthorIndexError(authorIndex, authorTable.length);
  }
  const author = authorTable[authorIndex];
  offset += 1;

  // Timestamp delta (2 bytes)
  const timestampDelta = view.getUint16(offset, false);
  const timestamp = baseTimestamp + timestampDelta;
  offset += 2;

  // Nonce (2 bytes)
  const nonce = view.getUint16(offset, false);
  offset += 2;

  // Flags (1 byte)
  const flags = view.getUint8(offset);
  const hasReply = (flags & 0x08) !== 0;
  const hasPkRegistry = (flags & 0x02) !== 0;
  offset += 1;

  // Content length (1 byte)
  const contentLength = view.getUint8(offset);
  offset += 1;

  // Content
  const contentBytes = data.slice(offset, offset + contentLength);
  const content = textDecoder.decode(contentBytes);
  offset += contentLength;

  // Reply-to (optional)
  let replyTo: `0x${string}` | undefined;
  if (hasReply) {
    replyTo = bytesToHex(data.slice(offset, offset + BYTES32_SIZE)) as `0x${string}`;
    offset += BYTES32_SIZE;
  }

  // PK registry index (optional)
  if (hasPkRegistry) {
    // Skip for now
    offset += 3;
  }

  const message: Message = {
    author,
    timestamp,
    nonce,
    content,
    replyTo,
  };

  return { message, offset };
}

/**
 * Decode a batch
 * @param data Batch data
 * @param dictionaryOrOptions Optional compression dictionary or decode options
 * @param options Optional decode options (if first arg is dictionary)
 * @returns Decoded batch
 */
export function decodeBatch(
  data: Uint8Array,
  dictionaryOrOptions?: ZstdDictionary | DecodeBatchOptions,
  options?: DecodeBatchOptions
): DecodedBatch {
  // Handle overloaded parameters
  let dictionary: ZstdDictionary | undefined;
  let decodeOptions: DecodeBatchOptions | undefined;

  if (dictionaryOrOptions) {
    // ZstdDictionary has 'data' property (Uint8Array), DecodeBatchOptions does not
    if ('data' in dictionaryOrOptions && dictionaryOrOptions.data instanceof Uint8Array) {
      // First arg is dictionary
      dictionary = dictionaryOrOptions;
      decodeOptions = options;
    } else {
      // First arg is options, not dictionary
      decodeOptions = dictionaryOrOptions as DecodeBatchOptions;
    }
  } else if (options) {
    // First arg was undefined, but third arg has options
    decodeOptions = options;
  }

  const batchStartOffset = decodeOptions?.batchStartOffset ?? 0;
  // Decode header
  const { header, offset: headerEndOffset } = decodeBatchHeader(data);

  let offset = headerEndOffset;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // Compressed data length (4 bytes)
  const compressedLength = view.getUint32(offset, false);
  offset += 4;

  // Compressed data
  const compressedData = data.slice(offset, offset + compressedLength);

  // Decompress if needed
  const flags = data[5]; // Flags at offset 5
  const isCompressed = (flags & BATCH_FLAG_COMPRESSED) !== 0;

  let messageData: Uint8Array;
  if (isCompressed && dictionary) {
    messageData = decompress(compressedData, dictionary);
  } else {
    messageData = compressedData;
  }

  // Decode messages
  const messages: Message[] = [];
  let msgOffset = 0;

  // We need to know how many messages to decode
  // This is in the header at a specific offset
  // Offset: 4 (magic) + 1 (version) + 1 (flags) + 32 (dict) + 4 (timestamp) + 2 (author count) + (N * 20) (authors)
  const msgCountOffset = 44 + header.authors.length * ADDRESS_SIZE;
  const messageCount = new DataView(data.buffer, data.byteOffset + msgCountOffset, 2).getUint16(
    0,
    false
  );

  for (let i = 0; i < messageCount; i++) {
    if (msgOffset >= messageData.length) {
      throw new BatchTruncatedError(messageCount, i);
    }

    const result = decodeBatchedMessage(
      messageData,
      msgOffset,
      header.authors,
      header.baseTimestamp
    );

    messages.push(result.message);
    msgOffset = result.offset;
  }

  return {
    header,
    messages,
    compressedSize: compressedLength,
    decompressedSize: messageData.length,
    batchStartOffset,
  };
}

/**
 * Estimate batch size for given messages
 * @param messages Messages to estimate
 * @param options Batch options
 * @returns Estimated size in bytes
 */
export function estimateBatchSize(messages: Message[], options?: BatchOptions): number {
  // Build author table
  const authorTable = buildAuthorTable(messages);

  // Header size
  const headerSize = BATCH_HEADER_FIXED_SIZE + authorTable.length * ADDRESS_SIZE;

  // Estimate message sizes
  let messagesSize = 0;
  for (const msg of messages) {
    const contentSize = textEncoder.encode(msg.content).length;
    const baseSize = 1 + 2 + 2 + 1 + 1 + contentSize; // AuthorIdx + TSDelta + Nonce + Flags + ContentLen + Content
    const replySize = msg.replyTo ? BYTES32_SIZE : 0;
    messagesSize += baseSize + replySize;
  }

  // Apply compression estimate
  const compressionRatio = options?.compress !== false ? 5.0 : 1.0;
  const compressedSize = Math.ceil(messagesSize / compressionRatio);

  // Total: header + compressed length field + compressed data
  return headerSize + 4 + compressedSize;
}

/**
 * Validate batch constraints
 * @param messages Messages to validate
 * @returns True if valid, throws error otherwise
 */
export function validateBatch(messages: Message[]): boolean {
  if (messages.length === 0) {
    throw new Error('Batch must contain at least one message');
  }

  // Check author count
  const authorTable = buildAuthorTable(messages);
  if (authorTable.length > MAX_AUTHORS_PER_BATCH) {
    throw new Error(
      `Too many unique authors: ${authorTable.length} (max ${MAX_AUTHORS_PER_BATCH})`
    );
  }

  // Check timestamp deltas
  const baseTimestamp = calculateBaseTimestamp(messages);
  for (const msg of messages) {
    const delta = msg.timestamp - baseTimestamp;
    if (delta < 0 || delta > MAX_TIMESTAMP_DELTA) {
      throw new TimestampOverflowError(delta, MAX_TIMESTAMP_DELTA);
    }
  }

  return true;
}
