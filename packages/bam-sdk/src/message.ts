/**
 * BAM ERC-8180 message primitives.
 *
 * `computeMessageHash` is the ERC-8180 standardised per-message identifier;
 * `computeMessageId` is the batch-scoped id (computable only after batch
 * assembly); `encodeContents` / `splitContents` assemble and parse the
 * tag-prefixed `contents` byte string BAM's wire format requires.
 *
 * Hex helpers (`hexToBytes` / `bytesToHex`) live alongside the message
 * primitives so every byte-level message operation sits in one module.
 *
 * @module bam-sdk/message
 */

import { keccak_256 } from '@noble/hashes/sha3';

import type { Address, BAMMessage, Bytes32 } from './types.js';
import { ContentsTooShortError } from './errors.js';

const CONTENT_TAG_PREFIX_BYTES = 32;

// ── Hex helpers ──────────────────────────────────────────────────────────

export function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return (
    '0x' +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  );
}

// ── ERC-8180 primitives ──────────────────────────────────────────────────

/**
 * ERC-8180 `messageHash`.
 *
 * `keccak256(abi.encodePacked(sender, nonce, contents))` — the
 * standardised per-message identifier ERC-8180 defines in §Terms /
 * §Signing Domain and Message Hash Convention. Chain-agnostic. Used as
 * the Poster's client-facing pre-batch identifier and as the input to
 * ECDSA's EIP-712 digest (which additionally binds chainId via the
 * signing domain).
 *
 * @param sender   20-byte message author address.
 * @param nonce    uint64 per-sender monotonic nonce.
 * @param contents Message content bytes. Length MUST be ≥ 32; the first 32
 *                 bytes are the ERC-8179 `contentTag` under BAM's
 *                 tag-prefixed contents convention. This function does
 *                 not enforce the length bound — callers that receive
 *                 `contents` at a trust boundary should check separately
 *                 or invoke `splitContents` first.
 */
export function computeMessageHash(
  sender: Address,
  nonce: bigint,
  contents: Uint8Array
): Bytes32 {
  if (nonce < 0n || nonce > 0xffffffffffffffffn) {
    throw new RangeError('nonce out of uint64 range');
  }

  const senderBytes = hexToBytes(sender);
  if (senderBytes.length !== 20) {
    throw new RangeError('sender must be 20 bytes');
  }

  const buf = new Uint8Array(20 + 8 + contents.length);
  buf.set(senderBytes, 0);
  writeUint64BE(buf, 20, nonce);
  buf.set(contents, 28);

  return bytesToHex(keccak_256(buf)) as Bytes32;
}

/**
 * Convenience: compute the ERC `messageHash` for a `BAMMessage`.
 */
export function computeMessageHashForMessage(message: BAMMessage): Bytes32 {
  return computeMessageHash(message.sender, message.nonce, message.contents);
}

/**
 * ERC-8180 `messageId`.
 *
 * `keccak256(abi.encodePacked(sender, nonce, batchContentHash))`. The
 * `batchContentHash` is the batch-scoped identifier — the EIP-4844
 * versioned hash for blob batches or `keccak256(batchData)` for
 * calldata batches. Only computable after the batch a message lands in
 * has been assembled.
 *
 * Note: the ERC's own wording uses `author` for the first field; BAM's
 * SDK uses `sender` throughout.
 */
export function computeMessageId(
  sender: Address,
  nonce: bigint,
  batchContentHash: Bytes32
): Bytes32 {
  if (nonce < 0n || nonce > 0xffffffffffffffffn) {
    throw new RangeError('nonce out of uint64 range');
  }

  const senderBytes = hexToBytes(sender);
  if (senderBytes.length !== 20) {
    throw new RangeError('sender must be 20 bytes');
  }

  const bchBytes = hexToBytes(batchContentHash);
  if (bchBytes.length !== 32) {
    throw new RangeError('batchContentHash must be 32 bytes');
  }

  const buf = new Uint8Array(20 + 8 + 32);
  buf.set(senderBytes, 0);
  writeUint64BE(buf, 20, nonce);
  buf.set(bchBytes, 28);

  return bytesToHex(keccak_256(buf)) as Bytes32;
}

/**
 * Assemble a `contents` byte string under BAM's tag-prefixed convention.
 *
 * Layout: `contentTag (32) ‖ appBytes (n)`. Returns a fresh buffer of
 * length `32 + appBytes.length`. `appBytes` may be zero-length.
 */
export function encodeContents(contentTag: Bytes32, appBytes: Uint8Array): Uint8Array {
  const tagBytes = hexToBytes(contentTag);
  if (tagBytes.length !== CONTENT_TAG_PREFIX_BYTES) {
    throw new RangeError('contentTag must be 32 bytes');
  }

  const out = new Uint8Array(CONTENT_TAG_PREFIX_BYTES + appBytes.length);
  out.set(tagBytes, 0);
  out.set(appBytes, CONTENT_TAG_PREFIX_BYTES);
  return out;
}

/**
 * Split a `contents` byte string into `(contentTag, appBytes)`.
 *
 * Throws `ContentsTooShortError` when `contents.length < 32`.
 */
export function splitContents(contents: Uint8Array): {
  contentTag: Bytes32;
  appBytes: Uint8Array;
} {
  if (contents.length < CONTENT_TAG_PREFIX_BYTES) {
    throw new ContentsTooShortError(contents.length);
  }

  const contentTag = bytesToHex(contents.slice(0, CONTENT_TAG_PREFIX_BYTES)) as Bytes32;
  // Return a view with the same backing buffer; callers that mutate must copy.
  const appBytes = contents.slice(CONTENT_TAG_PREFIX_BYTES);
  return { contentTag, appBytes };
}

function writeUint64BE(buf: Uint8Array, offset: number, value: bigint): void {
  for (let i = 7; i >= 0; i--) {
    buf[offset + i] = Number(value & 0xffn);
    value >>= 8n;
  }
}
