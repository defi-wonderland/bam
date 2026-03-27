/**
 * BAM Message Encoding/Decoding
 * @module bam-sdk/message
 */

import { keccak_256 } from '@noble/hashes/sha3';
import type {
  Address,
  Bytes32,
  EncodedMessage,
  ExtendedSignatureHeader,
  Message,
  MessageFlags,
  SignatureType,
  SignedMessage,
} from './types.js';
import { SignatureScheme } from './types.js'; // eslint-disable-line no-duplicate-imports
import {
  ADDRESS_SIZE,
  BLS_SIGNATURE_SIZE,
  BYTES32_SIZE,
  ECDSA_SIGNATURE_SIZE,
  EXTENDED_SIG_HEADER_SIZE,
  FLAG_COMPRESSED,
  FLAG_REPLY,
  FLAG_SIGNATURE_MASK,
  MAGIC_MESSAGE,
  MAX_CONTENT_BYTES,
  MAX_CONTENT_CHARS,
  MESSAGE_HEADER_SIZE,
  PROTOCOL_VERSION,
  SCHEME_ID_BLS,
  SCHEME_ID_ECDSA,
  SIG_TYPE_BLS,
  SIG_TYPE_ECDSA,
  SIG_TYPE_EXTENDED,
  SIG_TYPE_NONE,
} from './constants.js';
import {
  ContentTooLongError,
  InvalidFlagsError,
  InvalidMagicError,
  InvalidUtf8Error,
  UnknownSignatureSchemeError,
  UnsupportedSchemeVersionError,
  UnsupportedVersionError,
} from './errors.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

/** Options for encoding a message */
export interface EncodeMessageOptions {
  /** Maximum content length in characters (default: 280) */
  maxContentChars?: number;
  /** Maximum content length in bytes (default: 1120) */
  maxContentBytes?: number;
}

/**
 * Encode a message to binary format
 * @param msg Message to encode
 * @param options Optional encoding options (content length limits)
 * @returns Encoded binary data
 */
export function encodeMessage(msg: SignedMessage, options?: EncodeMessageOptions): Uint8Array {
  const maxChars = options?.maxContentChars ?? MAX_CONTENT_CHARS;
  const maxBytes = options?.maxContentBytes ?? MAX_CONTENT_BYTES;

  // Validate content
  const contentChars = [...msg.content].length;
  if (contentChars > maxChars) {
    throw new ContentTooLongError(contentChars, maxChars, 'characters');
  }

  const contentBytes = textEncoder.encode(msg.content);
  if (contentBytes.length > maxBytes) {
    throw new ContentTooLongError(contentBytes.length, maxBytes, 'bytes');
  }

  // Calculate sizes
  let signatureSize: number;
  let extendedHeaderSize = 0;

  if (msg.signatureType === 'extended') {
    if (!msg.extendedHeader) {
      throw new InvalidFlagsError(SIG_TYPE_EXTENDED, 'Extended signature requires extendedHeader');
    }
    extendedHeaderSize = EXTENDED_SIG_HEADER_SIZE;
    signatureSize = getSignatureSizeForScheme(msg.extendedHeader.scheme);
  } else {
    signatureSize = msg.signatureType === 'bls' ? BLS_SIGNATURE_SIZE : ECDSA_SIGNATURE_SIZE;
  }

  const replySize = msg.replyTo ? BYTES32_SIZE : 0;
  const contentLenSize = contentBytes.length > 255 ? 2 : 1;
  const totalSize =
    MESSAGE_HEADER_SIZE +
    contentLenSize -
    1 +
    contentBytes.length +
    replySize +
    extendedHeaderSize +
    signatureSize;

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let offset = 0;

  // Magic (4 bytes, big-endian)
  view.setUint32(offset, MAGIC_MESSAGE, false);
  offset += 4;

  // Version (1 byte)
  view.setUint8(offset, PROTOCOL_VERSION);
  offset += 1;

  // Flags (1 byte)
  const flags = buildMessageFlags(msg);
  view.setUint8(offset, flags);
  offset += 1;

  // Author (20 bytes)
  const authorBytes = hexToBytes(msg.author);
  bytes.set(authorBytes, offset);
  offset += ADDRESS_SIZE;

  // Timestamp (4 bytes, big-endian)
  view.setUint32(offset, msg.timestamp, false);
  offset += 4;

  // Nonce (2 bytes, big-endian)
  view.setUint16(offset, msg.nonce, false);
  offset += 2;

  // Content length (1 or 2 bytes)
  if (contentBytes.length > 255) {
    view.setUint16(offset, contentBytes.length, false);
    offset += 2;
  } else {
    view.setUint8(offset, contentBytes.length);
    offset += 1;
  }

  // Content
  bytes.set(contentBytes, offset);
  offset += contentBytes.length;

  // Reply-to (32 bytes, optional)
  if (msg.replyTo) {
    const replyBytes = hexToBytes(msg.replyTo);
    bytes.set(replyBytes, offset);
    offset += BYTES32_SIZE;
  }

  // Extended header (if extended mode)
  if (msg.signatureType === 'extended' && msg.extendedHeader) {
    const extHeader = encodeExtendedHeader(msg.extendedHeader);
    bytes.set(extHeader, offset);
    offset += EXTENDED_SIG_HEADER_SIZE;
  }

  // Signature
  bytes.set(msg.signature, offset);

  return bytes;
}

/**
 * Decode binary data to a message
 * @param data Binary data to decode
 * @returns Decoded message
 */
export function decodeMessage(data: Uint8Array): SignedMessage {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  // Magic (4 bytes)
  const magic = view.getUint32(offset, false);
  if (magic !== MAGIC_MESSAGE) {
    throw new InvalidMagicError(MAGIC_MESSAGE, magic);
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
  const parsedFlags = parseMessageFlags(flags);
  offset += 1;

  // Validate reserved bits
  if (flags & 0b11110000) {
    throw new InvalidFlagsError(flags, 'Reserved bits must be zero');
  }

  // Author (20 bytes)
  const author = bytesToHex(data.slice(offset, offset + ADDRESS_SIZE)) as Address;
  offset += ADDRESS_SIZE;

  // Timestamp (4 bytes)
  const timestamp = view.getUint32(offset, false);
  offset += 4;

  // Nonce (2 bytes)
  const nonce = view.getUint16(offset, false);
  offset += 2;

  // Content length (1 or 2 bytes based on flags)
  let contentLength: number;
  if (parsedFlags.compressed) {
    // Extended content length
    contentLength = view.getUint16(offset, false);
    offset += 2;
  } else {
    contentLength = view.getUint8(offset);
    offset += 1;
  }

  // Content
  const contentBytes = data.slice(offset, offset + contentLength);
  let content: string;
  try {
    content = textDecoder.decode(contentBytes);
  } catch {
    throw new InvalidUtf8Error();
  }
  offset += contentLength;

  // Reply-to (optional)
  let replyTo: Bytes32 | undefined;
  if (parsedFlags.hasReply) {
    replyTo = bytesToHex(data.slice(offset, offset + BYTES32_SIZE)) as Bytes32;
    offset += BYTES32_SIZE;
  }

  // Signature
  const signatureType = getSignatureType(parsedFlags.signatureType);
  let signature: Uint8Array;
  let extendedHeader: ExtendedSignatureHeader | undefined;

  if (signatureType === 'extended') {
    // Parse extended header
    extendedHeader = parseExtendedHeader(data.slice(offset));
    offset += EXTENDED_SIG_HEADER_SIZE;

    // Get signature size based on scheme
    const signatureSize = getSignatureSizeForScheme(extendedHeader.scheme);
    signature = data.slice(offset, offset + signatureSize);
  } else {
    const signatureSize = signatureType === 'bls' ? BLS_SIGNATURE_SIZE : ECDSA_SIGNATURE_SIZE;
    signature = data.slice(offset, offset + signatureSize);
  }

  return {
    author,
    timestamp,
    nonce,
    content,
    signature,
    signatureType,
    replyTo,
    extendedHeader,
  };
}

/**
 * Compute message ID (keccak256 hash)
 * @param msg Message to hash
 * @returns Message ID as bytes32
 */
export function computeMessageId(msg: Message): Bytes32 {
  const hash = computeMessageHash(msg);
  return bytesToHex(hash) as Bytes32;
}

/**
 * Compute message hash for signing
 * @param msg Message to hash
 * @returns 32-byte hash
 */
export function computeMessageHash(msg: Message): Uint8Array {
  const contentBytes = textEncoder.encode(msg.content);
  const authorBytes = hexToBytes(msg.author);

  // Build the data to hash
  const dataSize = 4 + 1 + 1 + ADDRESS_SIZE + 4 + 2 + 2 + contentBytes.length;
  const buffer = new ArrayBuffer(dataSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let offset = 0;

  // Magic
  view.setUint32(offset, MAGIC_MESSAGE, false);
  offset += 4;

  // Version
  view.setUint8(offset, PROTOCOL_VERSION);
  offset += 1;

  // Flags (signature type will be 0 for hash computation)
  view.setUint8(offset, msg.replyTo ? FLAG_REPLY : 0);
  offset += 1;

  // Author
  bytes.set(authorBytes, offset);
  offset += ADDRESS_SIZE;

  // Timestamp
  view.setUint32(offset, msg.timestamp, false);
  offset += 4;

  // Nonce
  view.setUint16(offset, msg.nonce, false);
  offset += 2;

  // Content length
  view.setUint16(offset, contentBytes.length, false);
  offset += 2;

  // Content
  bytes.set(contentBytes, offset);

  return keccak_256(bytes);
}

/**
 * Encode a message and compute its ID
 * @param msg Message to encode
 * @param options Optional encoding options (content length limits)
 * @returns Encoded message with ID and size
 */
export function encodeMessageWithId(msg: SignedMessage, options?: EncodeMessageOptions): EncodedMessage {
  const data = encodeMessage(msg, options);
  const messageId = computeMessageId(msg);
  return {
    data,
    messageId,
    size: data.length,
  };
}

/**
 * Build flags byte from message properties
 */
function buildMessageFlags(msg: SignedMessage): number {
  let flags = 0;

  // Signature type (bits 0-1)
  if (msg.signatureType === 'ecdsa') {
    flags |= SIG_TYPE_ECDSA;
  } else if (msg.signatureType === 'bls') {
    flags |= SIG_TYPE_BLS;
  } else if (msg.signatureType === 'extended') {
    flags |= SIG_TYPE_EXTENDED;
  }

  // Reply flag (bit 3)
  if (msg.replyTo) {
    flags |= FLAG_REPLY;
  }

  return flags;
}

/**
 * Parse flags byte to structured object
 */
function parseMessageFlags(flags: number): MessageFlags {
  return {
    signatureType: (flags & FLAG_SIGNATURE_MASK) as 0 | 1 | 2 | 3,
    compressed: (flags & FLAG_COMPRESSED) !== 0,
    hasReply: (flags & FLAG_REPLY) !== 0,
  };
}

/**
 * Convert signature type code to string
 */
function getSignatureType(code: number): SignatureType {
  switch (code) {
    case SIG_TYPE_ECDSA:
      return 'ecdsa';
    case SIG_TYPE_BLS:
      return 'bls';
    case SIG_TYPE_EXTENDED:
      return 'extended';
    case SIG_TYPE_NONE:
    default:
      throw new InvalidFlagsError(code, 'Invalid signature type');
  }
}

/**
 * Get signature size for a given scheme
 * @param scheme Signature scheme
 * @returns Size in bytes
 */
export function getSignatureSizeForScheme(scheme: SignatureScheme): number {
  switch (scheme) {
    case SignatureScheme.ECDSA:
      return ECDSA_SIGNATURE_SIZE;
    case SignatureScheme.BLS:
      return BLS_SIGNATURE_SIZE;
    case SignatureScheme.STARK:
      // STARK signatures are ~50KB (variable, returns max)
      throw new UnknownSignatureSchemeError(scheme);
    case SignatureScheme.Dilithium:
      // Dilithium signatures are ~2.5KB
      throw new UnknownSignatureSchemeError(scheme);
    default:
      throw new UnknownSignatureSchemeError(scheme);
  }
}

/**
 * Parse extended signature header
 * @param data Binary data starting at extended header
 * @returns Parsed extended header
 */
export function parseExtendedHeader(data: Uint8Array): ExtendedSignatureHeader {
  if (data.length < EXTENDED_SIG_HEADER_SIZE) {
    throw new InvalidFlagsError(0, 'Extended header truncated');
  }
  const schemeId = data[0];
  const schemeVersion = data[1];

  // Validate known schemes
  if (schemeId !== SCHEME_ID_ECDSA && schemeId !== SCHEME_ID_BLS && schemeId < 0x05) {
    // Schemes 0x03-0x04 are reserved for STARK/Dilithium
    if (schemeId === 0x03 || schemeId === 0x04) {
      throw new UnknownSignatureSchemeError(schemeId);
    }
  }

  // Currently only support version 1
  if (schemeVersion !== 1) {
    throw new UnsupportedSchemeVersionError(schemeId, schemeVersion);
  }

  return {
    scheme: schemeId as SignatureScheme,
    schemeVersion,
  };
}

/**
 * Encode extended signature header
 * @param header Extended header
 * @returns 2-byte header
 */
export function encodeExtendedHeader(header: ExtendedSignatureHeader): Uint8Array {
  const bytes = new Uint8Array(EXTENDED_SIG_HEADER_SIZE);
  bytes[0] = header.scheme;
  bytes[1] = header.schemeVersion;
  return bytes;
}

/**
 * Convert hex string to bytes
 */
export function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Convert bytes to hex string
 */
export function bytesToHex(bytes: Uint8Array): string {
  return (
    '0x' +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  );
}
