/**
 * Message encoding/decoding tests
 */

import { describe, it, expect } from 'vitest';
import {
  encodeMessage,
  decodeMessage,
  computeMessageId,
  computeMessageHash,
  hexToBytes,
  bytesToHex,
  MAGIC_MESSAGE,
  PROTOCOL_VERSION,
  BLS_SIGNATURE_SIZE,
  ECDSA_SIGNATURE_SIZE,
  MAX_CONTENT_CHARS,
  ContentTooLongError,
  InvalidMagicError,
  UnsupportedVersionError,
} from '../../src/index.js';
import type { SignedMessage, Address } from '../../src/index.js';

describe('Message Module', () => {
  // Test data
  const testAuthor: Address = '0x1234567890abcdef1234567890abcdef12345678';
  const testTimestamp = 1706400000;
  const testNonce = 42;
  const testContent = 'Hello, Social-Blobs!';

  // Generate a fake BLS signature (48 bytes)
  const fakeBLSSignature = new Uint8Array(BLS_SIGNATURE_SIZE).fill(0xab);

  // Generate a fake ECDSA signature (65 bytes)
  const fakeECDSASignature = new Uint8Array(ECDSA_SIGNATURE_SIZE).fill(0xcd);

  describe('encodeMessage', () => {
    it('should encode a minimal BLS message', () => {
      const msg: SignedMessage = {
        author: testAuthor,
        timestamp: testTimestamp,
        nonce: testNonce,
        content: testContent,
        signature: fakeBLSSignature,
        signatureType: 'bls',
      };

      const encoded = encodeMessage(msg);

      // Check magic number
      const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
      expect(view.getUint32(0, false)).toBe(MAGIC_MESSAGE);

      // Check version
      expect(view.getUint8(4)).toBe(PROTOCOL_VERSION);

      // Check flags (BLS = 0x02)
      expect(view.getUint8(5)).toBe(0x02);

      // Content should be present
      expect(encoded.length).toBeGreaterThan(0);
    });

    it('should encode an ECDSA message', () => {
      const msg: SignedMessage = {
        author: testAuthor,
        timestamp: testTimestamp,
        nonce: testNonce,
        content: testContent,
        signature: fakeECDSASignature,
        signatureType: 'ecdsa',
      };

      const encoded = encodeMessage(msg);

      // Check flags (ECDSA = 0x01)
      const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
      expect(view.getUint8(5)).toBe(0x01);
    });

    it('should encode a message with reply', () => {
      const msg: SignedMessage = {
        author: testAuthor,
        timestamp: testTimestamp,
        nonce: testNonce,
        content: testContent,
        signature: fakeBLSSignature,
        signatureType: 'bls',
        replyTo: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      };

      const encoded = encodeMessage(msg);

      // Check flags (BLS + Reply = 0x02 | 0x08 = 0x0a)
      const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
      expect(view.getUint8(5)).toBe(0x0a);

      // Size should include 32 bytes for reply-to
      const msgWithoutReply: SignedMessage = { ...msg, replyTo: undefined };
      const encodedWithoutReply = encodeMessage(msgWithoutReply);
      expect(encoded.length).toBe(encodedWithoutReply.length + 32);
    });

    it('should reject content exceeding 280 characters', () => {
      const longContent = 'x'.repeat(MAX_CONTENT_CHARS + 1);
      const msg: SignedMessage = {
        author: testAuthor,
        timestamp: testTimestamp,
        nonce: testNonce,
        content: longContent,
        signature: fakeBLSSignature,
        signatureType: 'bls',
      };

      expect(() => encodeMessage(msg)).toThrow(ContentTooLongError);
    });

    it('should accept longer content with custom maxContentChars', () => {
      const longContent = 'x'.repeat(500);
      const msg: SignedMessage = {
        author: testAuthor,
        timestamp: testTimestamp,
        nonce: testNonce,
        content: longContent,
        signature: fakeBLSSignature,
        signatureType: 'bls',
      };

      // Fails with default limit
      expect(() => encodeMessage(msg)).toThrow(ContentTooLongError);

      // Succeeds with raised limit
      const encoded = encodeMessage(msg, { maxContentChars: 1000, maxContentBytes: 4000 });
      expect(encoded.length).toBeGreaterThan(0);
    });

    it('should reject content exceeding custom maxContentChars', () => {
      const content = 'x'.repeat(100);
      const msg: SignedMessage = {
        author: testAuthor,
        timestamp: testTimestamp,
        nonce: testNonce,
        content,
        signature: fakeBLSSignature,
        signatureType: 'bls',
      };

      // Succeeds with default limit
      expect(() => encodeMessage(msg)).not.toThrow();

      // Fails with stricter limit
      expect(() => encodeMessage(msg, { maxContentChars: 50 })).toThrow(ContentTooLongError);
    });

    it('should handle empty content', () => {
      const msg: SignedMessage = {
        author: testAuthor,
        timestamp: testTimestamp,
        nonce: testNonce,
        content: '',
        signature: fakeBLSSignature,
        signatureType: 'bls',
      };

      const encoded = encodeMessage(msg);
      expect(encoded.length).toBeGreaterThan(0);
    });

    it('should handle Unicode content', () => {
      const msg: SignedMessage = {
        author: testAuthor,
        timestamp: testTimestamp,
        nonce: testNonce,
        content: 'Hello 世界! 🌍🚀',
        signature: fakeBLSSignature,
        signatureType: 'bls',
      };

      const encoded = encodeMessage(msg);
      expect(encoded.length).toBeGreaterThan(0);
    });
  });

  describe('decodeMessage', () => {
    it('should decode an encoded BLS message', () => {
      const original: SignedMessage = {
        author: testAuthor,
        timestamp: testTimestamp,
        nonce: testNonce,
        content: testContent,
        signature: fakeBLSSignature,
        signatureType: 'bls',
      };

      const encoded = encodeMessage(original);
      const decoded = decodeMessage(encoded);

      expect(decoded.author.toLowerCase()).toBe(original.author.toLowerCase());
      expect(decoded.timestamp).toBe(original.timestamp);
      expect(decoded.nonce).toBe(original.nonce);
      expect(decoded.content).toBe(original.content);
      expect(decoded.signatureType).toBe(original.signatureType);
      expect(bytesToHex(decoded.signature)).toBe(bytesToHex(original.signature));
    });

    it('should decode an encoded ECDSA message', () => {
      const original: SignedMessage = {
        author: testAuthor,
        timestamp: testTimestamp,
        nonce: testNonce,
        content: testContent,
        signature: fakeECDSASignature,
        signatureType: 'ecdsa',
      };

      const encoded = encodeMessage(original);
      const decoded = decodeMessage(encoded);

      expect(decoded.signatureType).toBe('ecdsa');
      expect(decoded.signature.length).toBe(ECDSA_SIGNATURE_SIZE);
    });

    it('should decode a message with reply', () => {
      const replyTo = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      const original: SignedMessage = {
        author: testAuthor,
        timestamp: testTimestamp,
        nonce: testNonce,
        content: testContent,
        signature: fakeBLSSignature,
        signatureType: 'bls',
        replyTo,
      };

      const encoded = encodeMessage(original);
      const decoded = decodeMessage(encoded);

      expect(decoded.replyTo?.toLowerCase()).toBe(replyTo.toLowerCase());
    });

    it('should reject invalid magic number', () => {
      const data = new Uint8Array(100);
      // Set wrong magic
      new DataView(data.buffer).setUint32(0, 0xdeadbeef, false);

      expect(() => decodeMessage(data)).toThrow(InvalidMagicError);
    });

    it('should reject unsupported version', () => {
      const msg: SignedMessage = {
        author: testAuthor,
        timestamp: testTimestamp,
        nonce: testNonce,
        content: testContent,
        signature: fakeBLSSignature,
        signatureType: 'bls',
      };

      const encoded = encodeMessage(msg);
      // Modify version byte
      encoded[4] = 0xff;

      expect(() => decodeMessage(encoded)).toThrow(UnsupportedVersionError);
    });
  });

  describe('computeMessageId', () => {
    it('should compute a consistent message ID', () => {
      const msg: SignedMessage = {
        author: testAuthor,
        timestamp: testTimestamp,
        nonce: testNonce,
        content: testContent,
        signature: fakeBLSSignature,
        signatureType: 'bls',
      };

      const id1 = computeMessageId(msg);
      const id2 = computeMessageId(msg);

      expect(id1).toBe(id2);
      expect(id1.startsWith('0x')).toBe(true);
      expect(id1.length).toBe(66); // 0x + 64 hex chars
    });

    it('should produce different IDs for different messages', () => {
      const msg1: SignedMessage = {
        author: testAuthor,
        timestamp: testTimestamp,
        nonce: testNonce,
        content: 'Message 1',
        signature: fakeBLSSignature,
        signatureType: 'bls',
      };

      const msg2: SignedMessage = {
        author: testAuthor,
        timestamp: testTimestamp,
        nonce: testNonce,
        content: 'Message 2',
        signature: fakeBLSSignature,
        signatureType: 'bls',
      };

      const id1 = computeMessageId(msg1);
      const id2 = computeMessageId(msg2);

      expect(id1).not.toBe(id2);
    });
  });

  describe('computeMessageHash', () => {
    it('should return a 32-byte hash', () => {
      const msg: SignedMessage = {
        author: testAuthor,
        timestamp: testTimestamp,
        nonce: testNonce,
        content: testContent,
        signature: fakeBLSSignature,
        signatureType: 'bls',
      };

      const hash = computeMessageHash(msg);
      expect(hash.length).toBe(32);
    });
  });

  describe('hexToBytes / bytesToHex', () => {
    it('should round-trip hex conversion', () => {
      const original = '0x1234567890abcdef';
      const bytes = hexToBytes(original);
      const hex = bytesToHex(bytes);

      expect(hex.toLowerCase()).toBe(original.toLowerCase());
    });

    it('should handle hex without 0x prefix', () => {
      const bytes = hexToBytes('abcd');
      expect(bytes.length).toBe(2);
      expect(bytes[0]).toBe(0xab);
      expect(bytes[1]).toBe(0xcd);
    });
  });
});
