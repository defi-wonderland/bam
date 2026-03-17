/**
 * Blob Parser for BAM Exposure
 * @module bam-sdk/exposure/blob-parser
 *
 * Parses blob data to extract individual messages with their byte positions,
 * enabling on-chain exposure with KZG proofs.
 */

import { keccak_256 } from '@noble/hashes/sha3';
import type { Address, Bytes32 } from '../types.js';
import type { ParseBlobOptions, ParsedBlob, ParsedMessage } from './types.js';
import type { Blob, VersionedHash } from '../kzg/types.js';
import { KZG_CONSTANTS, computeVersionedHash, commitToBlob } from '../kzg/proof-generator.js';
import { ADDRESS_SIZE, BYTES32_SIZE, BLS_SIGNATURE_SIZE } from '../constants.js';

/** Batch magic bytes: "SB" (0x53, 0x42) */
const BATCH_MAGIC = [0x53, 0x42] as const;
import { decompress } from '../compression.js';

const textDecoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Parse a blob to extract messages with position information
 * @param blob Raw blob data (131072 bytes)
 * @param optionsOrVersionedHash Optional options object or versioned hash (for backward compatibility)
 * @returns Parsed blob with messages
 */
export function parseBlob(
  blob: Blob,
  optionsOrVersionedHash?: ParseBlobOptions | VersionedHash
): ParsedBlob {
  // Handle backward-compatible overload
  let options: ParseBlobOptions;
  if (typeof optionsOrVersionedHash === 'string') {
    // Legacy call with just versionedHash
    options = { versionedHash: optionsOrVersionedHash };
  } else {
    options = optionsOrVersionedHash ?? {};
  }

  const batchStartOffset = options.batchStartOffset ?? 0;
  let { versionedHash } = options;

  // Compute versioned hash if not provided
  if (!versionedHash) {
    const { commitment } = commitToBlob(blob);
    versionedHash = computeVersionedHash(commitment);
  }

  // Extract usable bytes from blob, starting at batchStartOffset
  const usableData = extractUsableBytesFromBlob(blob, batchStartOffset);

  // Check for batch magic (0x53 0x42 = "SB")
  if (usableData[0] !== BATCH_MAGIC[0] || usableData[1] !== BATCH_MAGIC[1]) {
    throw new Error('Invalid blob: missing batch magic bytes');
  }

  // Parse batch header
  const { messages, compressed, dictionaryHash } = parseBatchHeader(usableData, batchStartOffset);

  return {
    versionedHash,
    messages,
    messageCount: messages.length,
    compressed,
    dictionaryHash,
    batchStartOffset,
  };
}

/**
 * Extract usable bytes from blob (skipping padding bytes)
 * Each field element has 31 usable bytes (byte 0 is padding)
 * @param blob Raw blob data
 * @param startOffset Byte offset to start extraction from (in usable bytes space)
 */
function extractUsableBytesFromBlob(blob: Blob, startOffset = 0): Uint8Array {
  const maxUsable = KZG_CONSTANTS.MAX_USABLE_BYTES - startOffset;
  const result = new Uint8Array(maxUsable);

  // Calculate starting field element and position within it
  const startFE = Math.floor(startOffset / KZG_CONSTANTS.USABLE_BYTES_PER_FE);
  const offsetInFirstFE = startOffset % KZG_CONSTANTS.USABLE_BYTES_PER_FE;

  let dstOffset = 0;

  for (
    let fe = startFE;
    fe < KZG_CONSTANTS.FIELD_ELEMENTS_PER_BLOB && dstOffset < maxUsable;
    fe++
  ) {
    const feByteStart = fe === startFE ? offsetInFirstFE : 0;
    const bytesToCopy = Math.min(
      KZG_CONSTANTS.USABLE_BYTES_PER_FE - feByteStart,
      maxUsable - dstOffset
    );

    // Source: skip byte 0 of field element (padding), then add feByteStart
    const srcOffset = fe * KZG_CONSTANTS.BYTES_PER_FIELD_ELEMENT + 1 + feByteStart;

    result.set(blob.slice(srcOffset, srcOffset + bytesToCopy), dstOffset);
    dstOffset += bytesToCopy;
  }

  return result;
}

/**
 * Parse batch header and extract messages
 * @param data Batch data (starting from batch header)
 * @param batchStartOffset Absolute offset in blob where batch starts
 */
function parseBatchHeader(
  data: Uint8Array,
  batchStartOffset = 0
): {
  messages: ParsedMessage[];
  compressed: boolean;
  dictionaryHash?: Bytes32;
  headerEndOffset: number;
} {
  let offset = 2; // Skip magic

  // Version (2 bytes) - skip for now
  offset += 2;

  // Flags (1 byte)
  const flags = data[offset++];
  const compressed = (flags & 0x01) !== 0;
  const sigType = (flags >> 4) & 0x03;

  // Dictionary reference (32 bytes) if compressed
  let dictionaryHash: Bytes32 | undefined;
  if (compressed) {
    const dictBytes = data.slice(offset, offset + BYTES32_SIZE);
    dictionaryHash = bytesToHex(dictBytes) as Bytes32;
    offset += BYTES32_SIZE;
  }

  // Base timestamp (4 bytes)
  const baseTimestamp = readUint32BE(data, offset);
  offset += 4;

  // Author count (1 byte)
  const authorCount = data[offset++];

  // Author table
  const authors: Address[] = [];
  for (let i = 0; i < authorCount; i++) {
    const authorBytes = data.slice(offset, offset + ADDRESS_SIZE);
    authors.push(bytesToHex(authorBytes) as Address);
    offset += ADDRESS_SIZE;
  }

  // Aggregate signature (48 bytes for BLS)
  const signatureSize = sigType === 2 ? BLS_SIGNATURE_SIZE : 0;
  offset += signatureSize;

  // Message count (2 bytes) - skip, we parse until we run out of data
  offset += 2;

  // Compressed data size (2 bytes) if compressed
  let compressedSize = 0;
  if (compressed) {
    compressedSize = readUint16BE(data, offset);
    offset += 2;
  }

  const headerEndOffset = offset;

  // Parse messages
  let messageData: Uint8Array;
  if (compressed && compressedSize > 0) {
    const compressedData = data.slice(offset, offset + compressedSize);
    // Decompress (requires dictionary to be loaded)
    try {
      messageData = decompress(compressedData);
    } catch {
      throw new Error('Failed to decompress message data. Dictionary may be required.');
    }
  } else {
    messageData = data.slice(offset);
  }

  const messages = parseMessages(
    messageData,
    authors,
    baseTimestamp,
    headerEndOffset,
    compressed,
    batchStartOffset
  );

  return { messages, compressed, dictionaryHash, headerEndOffset };
}

/**
 * Parse individual messages from message data
 * @param data Message data
 * @param authors Author table
 * @param baseTimestamp Base timestamp for delta encoding
 * @param headerOffset Offset after header (relative to batch)
 * @param compressed Whether messages are compressed
 * @param batchStartOffset Absolute offset in blob where batch starts
 */
function parseMessages(
  data: Uint8Array,
  authors: Address[],
  baseTimestamp: number,
  headerOffset: number,
  compressed: boolean,
  batchStartOffset = 0
): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  let offset = 0;
  let messageIndex = 0;

  while (offset < data.length) {
    // Check if remaining data is too small for a message
    if (data.length - offset < 4) break;

    // Message length (2 bytes)
    const msgLength = readUint16BE(data, offset);
    if (msgLength === 0) break; // End of messages marker

    const msgStart = offset;
    offset += 2;

    // Author index (1 byte)
    const authorIndex = data[offset++];
    if (authorIndex >= authors.length) {
      throw new Error(`Invalid author index: ${authorIndex}`);
    }
    const author = authors[authorIndex];

    // Timestamp delta (2 bytes)
    const timestampDelta = readUint16BE(data, offset);
    offset += 2;
    const timestamp = baseTimestamp + timestampDelta;

    // Nonce (2 bytes)
    const nonce = readUint16BE(data, offset);
    offset += 2;

    // Content (remaining bytes in message)
    const contentLength = msgLength - 7; // 2(len) + 1(author) + 2(ts) + 2(nonce)
    const contentBytes = data.slice(offset, offset + contentLength);
    offset += contentLength;

    let content: string;
    try {
      content = textDecoder.decode(contentBytes);
    } catch {
      content = '[Invalid UTF-8]';
    }

    // Build raw message bytes for on-chain verification
    // On-chain format: [author(20)][timestamp(4)][nonce(2)][content]
    const rawBytes = buildRawMessageBytes(author, timestamp, nonce, contentBytes);

    // Calculate message hash
    const messageHash = bytesToHex(keccak_256(rawBytes)) as Bytes32;

    // Calculate byte offset relative to batch start
    // This needs adjustment for compression
    const byteOffset = compressed
      ? headerOffset // Compressed messages start after header
      : headerOffset + msgStart;

    // Calculate absolute byte offset in the blob (for KZG proofs)
    const absoluteByteOffset = batchStartOffset + byteOffset;

    messages.push({
      author,
      timestamp,
      nonce,
      content,
      byteOffset,
      absoluteByteOffset,
      byteLength: rawBytes.length,
      messageIndex,
      rawBytes,
      messageHash,
    });

    messageIndex++;
  }

  return messages;
}

/**
 * Build raw message bytes in on-chain format
 * Format: [author(20)][timestamp(4)][nonce(2)][content]
 */
function buildRawMessageBytes(
  author: Address,
  timestamp: number,
  nonce: number,
  content: Uint8Array
): Uint8Array {
  const result = new Uint8Array(ADDRESS_SIZE + 4 + 2 + content.length);

  // Author (20 bytes)
  const authorBytes = hexToBytes(author);
  result.set(authorBytes, 0);

  // Timestamp (4 bytes, big-endian)
  result[20] = (timestamp >> 24) & 0xff;
  result[21] = (timestamp >> 16) & 0xff;
  result[22] = (timestamp >> 8) & 0xff;
  result[23] = timestamp & 0xff;

  // Nonce (2 bytes, big-endian)
  result[24] = (nonce >> 8) & 0xff;
  result[25] = nonce & 0xff;

  // Content
  result.set(content, 26);

  return result;
}

/**
 * Find a specific message in a parsed blob by index or hash
 * @param blob Parsed blob
 * @param identifier Message index or message hash
 * @returns Parsed message or undefined
 */
export function findMessage(
  blob: ParsedBlob,
  identifier: number | Bytes32
): ParsedMessage | undefined {
  if (typeof identifier === 'number') {
    return blob.messages[identifier];
  }

  return blob.messages.find((m) => m.messageHash === identifier);
}

/**
 * Get message position info for KZG proof generation
 * @param message Parsed message
 * @returns Position info for proof generation (uses absoluteByteOffset for KZG)
 */
export function getMessagePosition(message: ParsedMessage): {
  byteOffset: number;
  absoluteByteOffset: number;
  byteLength: number;
  fieldElementStart: number;
  fieldElementEnd: number;
  fieldElementCount: number;
} {
  // Use absoluteByteOffset for field element calculations (KZG proofs)
  const feStart = Math.floor(message.absoluteByteOffset / KZG_CONSTANTS.USABLE_BYTES_PER_FE);
  const feEnd = Math.floor(
    (message.absoluteByteOffset + message.byteLength - 1) / KZG_CONSTANTS.USABLE_BYTES_PER_FE
  );

  return {
    byteOffset: message.byteOffset,
    absoluteByteOffset: message.absoluteByteOffset,
    byteLength: message.byteLength,
    fieldElementStart: feStart,
    fieldElementEnd: feEnd,
    fieldElementCount: feEnd - feStart + 1,
  };
}

// Helper functions

function readUint16BE(data: Uint8Array, offset: number): number {
  return (data[offset] << 8) | data[offset + 1];
}

function readUint32BE(data: Uint8Array, offset: number): number {
  return (
    (data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]
  );
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return (
    '0x' +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  );
}
