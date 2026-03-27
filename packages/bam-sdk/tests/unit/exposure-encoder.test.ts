/**
 * Exposure encoder tests
 *
 * Tests the exposure batch encoding format where messages are stored in
 * on-chain raw format for KZG-verifiable exposure.
 */

import { describe, it, expect } from 'vitest';
import type { Address } from '../../src/types.js';
import {
  encodeExposureBatch,
  decodeExposureBatch,
  buildRawMessageBytes,
} from '../../src/exposure/encoder.js';
import type { ExposureMessage } from '../../src/exposure/encoder.js';
import { MAGIC_EXPOSURE, EXPOSURE_HEADER_SIZE, EXPOSURE_MSG_PREFIX_SIZE } from '../../src/constants.js';

const author1: Address = '0x1111111111111111111111111111111111111111';
const author2: Address = '0x2222222222222222222222222222222222222222';
const baseTimestamp = 1706400000;

function msg(author: Address, timestamp: number, nonce: number, content: string): ExposureMessage {
  return { author, timestamp, nonce, content };
}

describe('buildRawMessageBytes', () => {
  it('should encode message in on-chain format', () => {
    const raw = buildRawMessageBytes(author1, baseTimestamp, 0, 'Hello');
    // [author(20)][timestamp(4)][nonce(2)][content(5)] = 31 bytes
    expect(raw.length).toBe(31);

    // Author
    expect(raw[0]).toBe(0x11);
    expect(raw[19]).toBe(0x11);

    // Timestamp (big-endian)
    const ts = (raw[20] << 24) | (raw[21] << 16) | (raw[22] << 8) | raw[23];
    expect(ts).toBe(baseTimestamp);

    // Nonce (big-endian)
    const nonce = (raw[24] << 8) | raw[25];
    expect(nonce).toBe(0);

    // Content
    const content = new TextDecoder().decode(raw.slice(26));
    expect(content).toBe('Hello');
  });
});

describe('encodeExposureBatch', () => {
  it('should encode a single message', () => {
    const batch = encodeExposureBatch([msg(author1, baseTimestamp, 0, 'Test')]);

    expect(batch.messageCount).toBe(1);
    expect(batch.headerSize).toBe(EXPOSURE_HEADER_SIZE);
    expect(batch.messageOffsets.length).toBe(1);
    expect(batch.messageLengths.length).toBe(1);

    // Verify magic
    const view = new DataView(batch.data.buffer);
    expect(view.getUint32(0, false)).toBe(MAGIC_EXPOSURE);

    // Verify version
    expect(batch.data[4]).toBe(0x01);

    // Verify message count
    expect(view.getUint16(6, false)).toBe(1);
  });

  it('should encode multiple messages', () => {
    const messages = [
      msg(author1, baseTimestamp, 0, 'First'),
      msg(author2, baseTimestamp + 10, 1, 'Second'),
      msg(author1, baseTimestamp + 20, 1, 'Third'),
    ];

    const batch = encodeExposureBatch(messages);
    expect(batch.messageCount).toBe(3);
    expect(batch.messageOffsets.length).toBe(3);

    // Each offset should be past the length prefix
    for (let i = 0; i < 3; i++) {
      const offset = batch.messageOffsets[i];
      // The 2 bytes before the offset should be the length prefix
      const view = new DataView(batch.data.buffer);
      const prefixOffset = offset - EXPOSURE_MSG_PREFIX_SIZE;
      const len = view.getUint16(prefixOffset, false);
      expect(len).toBe(batch.messageLengths[i]);
    }
  });

  it('should store messages in on-chain raw format at claimed offsets', () => {
    const messages = [
      msg(author1, baseTimestamp, 0, 'Hello'),
      msg(author2, baseTimestamp + 5, 3, 'World'),
    ];

    const batch = encodeExposureBatch(messages);

    for (let i = 0; i < messages.length; i++) {
      const offset = batch.messageOffsets[i];
      const length = batch.messageLengths[i];
      const extracted = batch.data.slice(offset, offset + length);
      const expected = buildRawMessageBytes(
        messages[i].author,
        messages[i].timestamp,
        messages[i].nonce,
        messages[i].content
      );
      expect(extracted).toEqual(expected);
    }
  });

  it('should reject empty message array', () => {
    expect(() => encodeExposureBatch([])).toThrow('Cannot create empty');
  });

  it('should include aggregate signature when provided', () => {
    const aggSig = new Uint8Array(48).fill(0xab);
    const batch = encodeExposureBatch(
      [msg(author1, baseTimestamp, 0, 'Test')],
      aggSig
    );

    // Flag byte should indicate aggregate sig present
    expect(batch.data[5] & 0x01).toBe(1);

    // Signature should be at offset 8
    const sig = batch.data.slice(8, 56);
    expect(sig).toEqual(aggSig);
  });
});

describe('decodeExposureBatch', () => {
  it('should roundtrip single message', () => {
    const original = [msg(author1, baseTimestamp, 42, 'Hello world!')];
    const encoded = encodeExposureBatch(original);
    const decoded = decodeExposureBatch(encoded.data);

    expect(decoded.messageCount).toBe(1);
    expect(decoded.messages[0].author).toBe(author1);
    expect(decoded.messages[0].timestamp).toBe(baseTimestamp);
    expect(decoded.messages[0].nonce).toBe(42);
    expect(decoded.messages[0].content).toBe('Hello world!');
  });

  it('should roundtrip multiple messages', () => {
    const original = [
      msg(author1, baseTimestamp, 0, 'First message'),
      msg(author2, baseTimestamp + 100, 5, 'Second message'),
      msg(author1, baseTimestamp + 200, 1, 'Third message with more content here'),
    ];

    const encoded = encodeExposureBatch(original);
    const decoded = decodeExposureBatch(encoded.data);

    expect(decoded.messageCount).toBe(3);
    for (let i = 0; i < original.length; i++) {
      expect(decoded.messages[i].author).toBe(original[i].author);
      expect(decoded.messages[i].timestamp).toBe(original[i].timestamp);
      expect(decoded.messages[i].nonce).toBe(original[i].nonce);
      expect(decoded.messages[i].content).toBe(original[i].content);
    }
  });

  it('should preserve rawBytes in decoded output', () => {
    const original = [msg(author1, baseTimestamp, 7, 'Content')];
    const encoded = encodeExposureBatch(original);
    const decoded = decodeExposureBatch(encoded.data);

    const expected = buildRawMessageBytes(author1, baseTimestamp, 7, 'Content');
    expect(decoded.messages[0].rawBytes).toEqual(expected);
  });

  it('should reject invalid magic', () => {
    const data = new Uint8Array(100);
    data[0] = 0xff;
    expect(() => decodeExposureBatch(data)).toThrow('Invalid exposure batch magic');
  });

  it('should roundtrip aggregate signature', () => {
    const aggSig = new Uint8Array(48).fill(0xcd);
    const encoded = encodeExposureBatch(
      [msg(author1, baseTimestamp, 0, 'Test')],
      aggSig
    );
    const decoded = decodeExposureBatch(encoded.data);

    expect(decoded.hasAggregateSignature).toBe(true);
    expect(decoded.aggregateSignature).toEqual(aggSig);
  });
});

describe('byte offset correctness', () => {
  it('should have offsets that extract correct rawBytes from batch data', () => {
    const messages = [
      msg(author1, baseTimestamp, 0, 'Short'),
      msg(author2, baseTimestamp + 1, 1, 'A longer message with more content'),
      msg(author1, baseTimestamp + 2, 2, 'x'),
    ];

    const batch = encodeExposureBatch(messages);

    for (let i = 0; i < messages.length; i++) {
      const offset = batch.messageOffsets[i];
      const length = batch.messageLengths[i];

      // Extract bytes from batch data at the claimed offset
      const extracted = batch.data.slice(offset, offset + length);

      // Build expected rawBytes independently
      const expected = buildRawMessageBytes(
        messages[i].author,
        messages[i].timestamp,
        messages[i].nonce,
        messages[i].content
      );

      // These MUST be identical — this is what KZG proofs will verify
      expect(extracted).toEqual(expected);
      expect(length).toBe(expected.length);
    }
  });

  it('should have contiguous message layout', () => {
    const messages = [
      msg(author1, baseTimestamp, 0, 'A'),
      msg(author1, baseTimestamp, 1, 'BB'),
      msg(author1, baseTimestamp, 2, 'CCC'),
    ];

    const batch = encodeExposureBatch(messages);

    // First message starts right after header + 2-byte length prefix
    expect(batch.messageOffsets[0]).toBe(EXPOSURE_HEADER_SIZE + EXPOSURE_MSG_PREFIX_SIZE);

    // Subsequent messages follow contiguously
    for (let i = 1; i < messages.length; i++) {
      const prevEnd = batch.messageOffsets[i - 1] + batch.messageLengths[i - 1];
      const expectedStart = prevEnd + EXPOSURE_MSG_PREFIX_SIZE;
      expect(batch.messageOffsets[i]).toBe(expectedStart);
    }
  });
});
