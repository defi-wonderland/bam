/**
 * Exposure Batch Encoder/Decoder
 * @module bam-sdk/exposure/encoder
 *
 * Encodes messages in on-chain raw format for KZG-verifiable exposure.
 * Each message is stored as [author(20)][timestamp(4)][nonce(2)][content],
 * which is exactly the format BLSExposer.expose() verifies.
 *
 * Format:
 *   Header: [magic(4)][version(1)][flags(1)][msgCount(2)][aggregateSig(48)]
 *   Messages: [len(2)][rawBytes: author(20)+ts(4)+nonce(2)+content(N)] ...
 */

import type { Address } from '../types.js';
import type { ExposureBatch, DecodedExposureBatch } from './types.js';
import {
  MAGIC_EXPOSURE,
  PROTOCOL_VERSION,
  BLS_SIGNATURE_SIZE,
  ADDRESS_SIZE,
  EXPOSURE_HEADER_SIZE,
  EXPOSURE_MSG_PREFIX_SIZE,
  BLOB_USABLE_CAPACITY,
} from '../constants.js';

/** Flag: aggregate BLS signature present */
const FLAG_HAS_AGGREGATE_SIG = 0x01;

export interface ExposureMessage {
  author: Address;
  timestamp: number;
  nonce: number;
  content: string;
}

/**
 * Build raw message bytes in on-chain format.
 * Format: [author(20)][timestamp(4)][nonce(2)][content]
 */
export function buildRawMessageBytes(
  author: Address,
  timestamp: number,
  nonce: number,
  content: string
): Uint8Array {
  const contentBytes = new TextEncoder().encode(content);
  const result = new Uint8Array(ADDRESS_SIZE + 4 + 2 + contentBytes.length);

  // Author (20 bytes)
  const authorHex = author.startsWith('0x') ? author.slice(2) : author;
  for (let i = 0; i < ADDRESS_SIZE; i++) {
    result[i] = parseInt(authorHex.slice(i * 2, i * 2 + 2), 16);
  }

  // Timestamp (4 bytes, big-endian)
  result[20] = (timestamp >>> 24) & 0xff;
  result[21] = (timestamp >>> 16) & 0xff;
  result[22] = (timestamp >>> 8) & 0xff;
  result[23] = timestamp & 0xff;

  // Nonce (2 bytes, big-endian)
  result[24] = (nonce >>> 8) & 0xff;
  result[25] = nonce & 0xff;

  // Content
  result.set(contentBytes, 26);

  return result;
}

/**
 * Encode messages into an exposure batch.
 *
 * Messages are stored in on-chain raw format, each prefixed with a 2-byte length.
 * The byte offsets returned point directly to the rawBytes (past the length prefix),
 * making them suitable for KZG proof generation.
 *
 * @param messages Messages to encode
 * @param aggregateSignature Optional 48-byte aggregate BLS signature
 * @returns Encoded exposure batch with byte offset metadata
 */
export function encodeExposureBatch(
  messages: ExposureMessage[],
  aggregateSignature?: Uint8Array
): ExposureBatch {
  if (messages.length === 0) {
    throw new Error('Cannot create empty exposure batch');
  }
  if (messages.length > 65535) {
    throw new Error(`Too many messages: ${messages.length} (max 65535)`);
  }

  // Build raw bytes for each message
  const rawBytesList: Uint8Array[] = messages.map((m) =>
    buildRawMessageBytes(m.author, m.timestamp, m.nonce, m.content)
  );

  // Calculate total size
  const messagesSize = rawBytesList.reduce(
    (sum, raw) => sum + EXPOSURE_MSG_PREFIX_SIZE + raw.length,
    0
  );
  const totalSize = EXPOSURE_HEADER_SIZE + messagesSize;

  if (totalSize > BLOB_USABLE_CAPACITY) {
    throw new Error(
      `Exposure batch too large: ${totalSize} bytes (max ${BLOB_USABLE_CAPACITY} for EIP-4844 blob)`
    );
  }

  // Allocate buffer
  const buffer = new Uint8Array(totalSize);
  const view = new DataView(buffer.buffer);
  let offset = 0;

  // Header: magic (4 bytes)
  view.setUint32(offset, MAGIC_EXPOSURE, false);
  offset += 4;

  // Header: version (1 byte)
  buffer[offset++] = PROTOCOL_VERSION;

  // Header: flags (1 byte)
  const hasAggSig = !!aggregateSignature;
  if (hasAggSig && aggregateSignature.length !== BLS_SIGNATURE_SIZE) {
    throw new Error(
      `Invalid aggregate signature length: ${aggregateSignature.length} (expected ${BLS_SIGNATURE_SIZE})`
    );
  }
  buffer[offset++] = hasAggSig ? FLAG_HAS_AGGREGATE_SIG : 0;

  // Header: message count (2 bytes)
  view.setUint16(offset, messages.length, false);
  offset += 2;

  // Header: aggregate BLS signature (48 bytes)
  if (hasAggSig) {
    buffer.set(aggregateSignature, offset);
  }
  // else: stays zero-filled
  offset += BLS_SIGNATURE_SIZE;

  // Messages
  const messageOffsets: number[] = [];
  const messageLengths: number[] = [];

  for (let i = 0; i < rawBytesList.length; i++) {
    const rawBytes = rawBytesList[i];
    if (rawBytes.length > 0xffff) {
      throw new Error(
        `Message ${i} too large for uint16 length prefix: ${rawBytes.length} bytes (max 65535)`
      );
    }

    // Length prefix (2 bytes)
    view.setUint16(offset, rawBytes.length, false);
    offset += EXPOSURE_MSG_PREFIX_SIZE;

    // Record offset (pointing to rawBytes, past the length prefix)
    messageOffsets.push(offset);
    messageLengths.push(rawBytes.length);

    // Raw message bytes
    buffer.set(rawBytes, offset);
    offset += rawBytes.length;
  }

  return {
    data: buffer,
    headerSize: EXPOSURE_HEADER_SIZE,
    totalSize,
    messageCount: messages.length,
    messageOffsets,
    messageLengths,
  };
}

/**
 * Decode an exposure batch back into messages.
 *
 * @param data Encoded exposure batch data
 * @returns Decoded messages
 */
export function decodeExposureBatch(data: Uint8Array): DecodedExposureBatch {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  // Magic (4 bytes)
  const magic = view.getUint32(offset, false);
  if (magic !== MAGIC_EXPOSURE) {
    throw new Error(
      `Invalid exposure batch magic: 0x${magic.toString(16)} (expected 0x${MAGIC_EXPOSURE.toString(16)})`
    );
  }
  offset += 4;

  // Version (1 byte)
  const version = data[offset++];
  if (version !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported version: ${version}`);
  }

  // Flags (1 byte)
  const flags = data[offset++];
  const hasAggregateSignature = (flags & FLAG_HAS_AGGREGATE_SIG) !== 0;

  // Message count (2 bytes)
  const messageCount = view.getUint16(offset, false);
  offset += 2;

  // Aggregate signature (48 bytes)
  const aggregateSignature = data.slice(offset, offset + BLS_SIGNATURE_SIZE);
  offset += BLS_SIGNATURE_SIZE;

  // Parse messages
  const textDecoder = new TextDecoder('utf-8', { fatal: true });
  const messages: DecodedExposureBatch['messages'] = [];

  for (let i = 0; i < messageCount; i++) {
    if (offset + EXPOSURE_MSG_PREFIX_SIZE > data.length) {
      throw new Error(`Truncated exposure batch at message ${i}`);
    }

    // Length prefix (2 bytes)
    const rawLen = view.getUint16(offset, false);
    offset += EXPOSURE_MSG_PREFIX_SIZE;

    if (offset + rawLen > data.length) {
      throw new Error(`Truncated message ${i}: need ${rawLen} bytes, have ${data.length - offset}`);
    }

    // Raw bytes
    const rawBytes = data.slice(offset, offset + rawLen);
    offset += rawLen;

    // Parse: [author(20)][timestamp(4)][nonce(2)][content]
    if (rawLen < 26) {
      throw new Error(`Message ${i} too short: ${rawLen} bytes (min 26)`);
    }

    const authorBytes = rawBytes.slice(0, ADDRESS_SIZE);
    const author = ('0x' +
      Array.from(authorBytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')) as Address;

    const timestamp =
      ((rawBytes[20] << 24) | (rawBytes[21] << 16) | (rawBytes[22] << 8) | rawBytes[23]) >>> 0;

    const nonce = (rawBytes[24] << 8) | rawBytes[25];

    const contentBytes = rawBytes.slice(26);
    let content: string;
    try {
      content = textDecoder.decode(contentBytes);
    } catch {
      content = '[Invalid UTF-8]';
    }

    messages.push({ author, timestamp, nonce, content, rawBytes });
  }

  return {
    messages,
    messageCount,
    aggregateSignature,
    hasAggregateSignature,
  };
}
