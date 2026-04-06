/**
 * Blob Parser for BAM Exposure
 * @module bam-sdk/exposure/blob-parser
 *
 * Parses exposure-format blobs to extract individual messages with their
 * byte positions, enabling on-chain exposure with KZG proofs.
 *
 * The exposure format stores each message in on-chain raw format:
 *   [author(20)][timestamp(4)][nonce(2)][content]
 * This is exactly what BLSExposer.expose() verifies via KZG proofs.
 */

import { keccak_256 } from '@noble/hashes/sha3';
import type { Address, Bytes32 } from '../types.js';
import type { ParseBlobOptions, ParsedBlob, ParsedMessage } from './types.js';
import type { Blob, VersionedHash } from '../kzg/types.js';
import { KZG_CONSTANTS, computeVersionedHash, commitToBlob } from '../kzg/proof-generator.js';
import {
  MAGIC_EXPOSURE,
  PROTOCOL_VERSION,
  ADDRESS_SIZE,
  EXPOSURE_HEADER_SIZE,
  EXPOSURE_MSG_PREFIX_SIZE,
} from '../constants.js';

const textDecoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Parse an exposure-format blob to extract messages with position information.
 *
 * Each returned message has `absoluteByteOffset` and `byteLength` that point
 * directly to the raw message bytes in the blob — suitable for KZG proof generation.
 *
 * @param blob Raw blob data (131072 bytes)
 * @param optionsOrVersionedHash Options or versioned hash for backward compat
 * @returns Parsed blob with messages and their byte positions
 */
export function parseBlob(
  blob: Blob,
  optionsOrVersionedHash?: ParseBlobOptions | VersionedHash
): ParsedBlob {
  let options: ParseBlobOptions;
  if (typeof optionsOrVersionedHash === 'string') {
    options = { versionedHash: optionsOrVersionedHash };
  } else {
    options = optionsOrVersionedHash ?? {};
  }

  const EXPECTED_BLOB_SIZE = 131072; // 4096 field elements * 32 bytes
  if (blob.length !== EXPECTED_BLOB_SIZE) {
    throw new Error(
      `Invalid blob size: ${blob.length} (expected ${EXPECTED_BLOB_SIZE})`
    );
  }

  const batchStartOffset = options.batchStartOffset ?? 0;
  let { versionedHash } = options;

  if (!versionedHash) {
    const { commitment } = commitToBlob(blob);
    versionedHash = computeVersionedHash(commitment);
  }

  // Extract usable bytes from blob
  const usableData = extractUsableBytesFromBlob(blob, batchStartOffset);

  // Verify magic
  const magic =
    (usableData[0] << 24) | (usableData[1] << 16) | (usableData[2] << 8) | usableData[3];
  if (magic !== MAGIC_EXPOSURE) {
    throw new Error(
      `Invalid exposure batch magic: 0x${magic.toString(16)} (expected 0x${MAGIC_EXPOSURE.toString(16)})`
    );
  }

  // Parse header
  const version = usableData[4];
  if (version !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported version: ${version}`);
  }

  // flags at offset 5 (reserved for future use)
  // const flags = usableData[5];

  const messageCount = (usableData[6] << 8) | usableData[7];

  // Skip aggregate signature (48 bytes, present regardless — zeros if not set)
  // Header ends at offset EXPOSURE_HEADER_SIZE (56)

  // Parse messages
  const messages: ParsedMessage[] = [];
  let offset = EXPOSURE_HEADER_SIZE;

  for (let i = 0; i < messageCount; i++) {
    if (offset + EXPOSURE_MSG_PREFIX_SIZE > usableData.length) {
      throw new Error(`Truncated exposure batch at message ${i}: no length prefix`);
    }

    // Length prefix (2 bytes)
    const rawLen = (usableData[offset] << 8) | usableData[offset + 1];
    offset += EXPOSURE_MSG_PREFIX_SIZE;

    if (rawLen === 0) {
      throw new Error(`Message ${i} has zero length`);
    }
    if (offset + rawLen > usableData.length) {
      throw new Error(
        `Truncated exposure batch at message ${i}: need ${rawLen} bytes, have ${usableData.length - offset}`
      );
    }
    if (rawLen < 26) {
      throw new Error(`Message ${i} too short: ${rawLen} bytes (min 26)`);
    }

    // The rawBytes start here — this is the KZG-provable offset
    const rawBytesOffset = offset; // relative to batch start in usable bytes
    const rawBytes = usableData.slice(offset, offset + rawLen);
    offset += rawLen;

    // Parse: [author(20)][timestamp(4)][nonce(2)][content]
    const author = bytesToHex(rawBytes.slice(0, ADDRESS_SIZE)) as Address;

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

    const messageHash = bytesToHex(keccak_256(rawBytes)) as Bytes32;

    messages.push({
      author,
      timestamp,
      nonce,
      content,
      byteOffset: rawBytesOffset,
      absoluteByteOffset: batchStartOffset + rawBytesOffset,
      byteLength: rawLen,
      messageIndex: i,
      rawBytes,
      messageHash,
    });
  }

  if (messages.length !== messageCount) {
    throw new Error(
      `Message count mismatch: header declares ${messageCount}, but parsed ${messages.length}`
    );
  }

  return {
    versionedHash,
    messages,
    messageCount,
    compressed: false,
    batchStartOffset,
  };
}

/**
 * Find a specific message in a parsed blob by index or hash
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
 */
export function getMessagePosition(message: ParsedMessage): {
  byteOffset: number;
  absoluteByteOffset: number;
  byteLength: number;
  fieldElementStart: number;
  fieldElementEnd: number;
  fieldElementCount: number;
} {
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

// ═══════════════════════════════════════════════════════════════════════════════
// Internal helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extract usable bytes from blob (skipping padding bytes).
 * Each field element has 31 usable bytes (byte 0 is padding).
 */
function extractUsableBytesFromBlob(blob: Blob, startOffset = 0): Uint8Array {
  const maxUsable = KZG_CONSTANTS.MAX_USABLE_BYTES - startOffset;
  const result = new Uint8Array(maxUsable);

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

    const srcOffset = fe * KZG_CONSTANTS.BYTES_PER_FIELD_ELEMENT + 1 + feByteStart;
    result.set(blob.slice(srcOffset, srcOffset + bytesToCopy), dstOffset);
    dstOffset += bytesToCopy;
  }

  return result;
}

function bytesToHex(bytes: Uint8Array): string {
  return (
    '0x' +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  );
}
