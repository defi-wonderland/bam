/**
 * BAM ERC-8180 message primitives.
 *
 * `computeMessageHash` is the ERC-8180 standardised per-message identifier;
 * `computeMessageId` is the batch-scoped id (computable only after batch
 * assembly). Both bind the batch's `contentTag` into the hash so a signed
 * message cannot be re-routed into a different app's segment.
 *
 * Hex helpers (`hexToBytes` / `bytesToHex`) live alongside the message
 * primitives so every byte-level message operation sits in one module.
 *
 * @module bam-sdk/message
 */

import { keccak_256 } from '@noble/hashes/sha3';

import type { Address, BAMMessage, Bytes32 } from './types.js';

// ── Hex helpers ──────────────────────────────────────────────────────────

/**
 * Parse a hex string (with or without `0x` prefix) into bytes.
 *
 * Throws `RangeError` on odd-length input or any non-hex character —
 * malformed input must fail loudly rather than silently decoding to
 * zero/NaN bytes (which would produce wrong hashes/signatures without
 * any error at the callsite).
 */
export function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (cleanHex.length % 2 !== 0) {
    throw new RangeError('hex string must have even length');
  }
  if (!/^[0-9a-fA-F]*$/.test(cleanHex)) {
    throw new RangeError('hex string contains non-hex characters');
  }
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
 * `keccak256(abi.encodePacked(sender, contentTag, nonce, contents))` —
 * the standardised per-message identifier ERC-8180 defines in §Terms /
 * §Signing Domain and Message Hash Convention. Chain-agnostic. Used as
 * the Poster's client-facing pre-batch identifier and as the input to
 * ECDSA's EIP-712 digest (which additionally binds chainId via the
 * signing domain).
 *
 * @param sender     20-byte message sender address.
 * @param contentTag 32-byte protocol/content identifier for the batch.
 *                   MUST equal the `contentTag` emitted in the
 *                   `BlobBatchRegistered` / `CalldataBatchRegistered`
 *                   event for the batch the message belongs to.
 * @param nonce      uint64 per-sender monotonic nonce.
 * @param contents   Message content bytes (opaque body; no per-message
 *                   tag prefix).
 */
export function computeMessageHash(
  sender: Address,
  contentTag: Bytes32,
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

  const tagBytes = hexToBytes(contentTag);
  if (tagBytes.length !== 32) {
    throw new RangeError('contentTag must be 32 bytes');
  }

  const buf = new Uint8Array(20 + 32 + 8 + contents.length);
  buf.set(senderBytes, 0);
  buf.set(tagBytes, 20);
  writeUint64BE(buf, 52, nonce);
  buf.set(contents, 60);

  return bytesToHex(keccak_256(buf)) as Bytes32;
}

/**
 * Convenience: compute the ERC `messageHash` for a `BAMMessage`.
 *
 * `contentTag` is supplied separately because it is a property of the
 * batch the message lands in (read from the registration event), not
 * of the message itself.
 */
export function computeMessageHashForMessage(
  message: BAMMessage,
  contentTag: Bytes32
): Bytes32 {
  return computeMessageHash(message.sender, contentTag, message.nonce, message.contents);
}

/**
 * ERC-8180 `messageId`.
 *
 * `keccak256(abi.encodePacked(sender, contentTag, nonce, batchContentHash))`.
 * The `batchContentHash` is the batch-scoped identifier — the EIP-4844
 * versioned hash for blob batches or `keccak256(batchData)` for
 * calldata batches. Only computable after the batch a message lands in
 * has been assembled.
 *
 * Binding `contentTag` here means two messages with the same
 * `(sender, nonce)` posted to distinct apps produce distinct
 * `messageId`s — they are distinct messages under the per-app
 * identity model.
 */
export function computeMessageId(
  sender: Address,
  contentTag: Bytes32,
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

  const tagBytes = hexToBytes(contentTag);
  if (tagBytes.length !== 32) {
    throw new RangeError('contentTag must be 32 bytes');
  }

  const bchBytes = hexToBytes(batchContentHash);
  if (bchBytes.length !== 32) {
    throw new RangeError('batchContentHash must be 32 bytes');
  }

  const buf = new Uint8Array(20 + 32 + 8 + 32);
  buf.set(senderBytes, 0);
  buf.set(tagBytes, 20);
  writeUint64BE(buf, 52, nonce);
  buf.set(bchBytes, 60);

  return bytesToHex(keccak_256(buf)) as Bytes32;
}

function writeUint64BE(buf: Uint8Array, offset: number, value: bigint): void {
  for (let i = 7; i >= 0; i--) {
    buf[offset + i] = Number(value & 0xffn);
    value >>= 8n;
  }
}
