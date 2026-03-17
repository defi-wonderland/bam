/**
 * Batch encoding/decoding tests
 */

import { describe, it, expect } from 'vitest';
import {
  buildAuthorTable,
  encodeBatch,
  decodeBatch,
  estimateBatchSize,
  validateBatch,
  MAGIC_BATCH,
  PROTOCOL_VERSION,
  BLS_SIGNATURE_SIZE,
  BatchOverflowError,
} from '../../src/index.js';
import type { Address, SignedMessage } from '../../src/index.js';

describe('Batch Module', () => {
  // Test data
  const author1: Address = '0x1111111111111111111111111111111111111111';
  const author2: Address = '0x2222222222222222222222222222222222222222';
  const author3: Address = '0x3333333333333333333333333333333333333333';

  const baseTimestamp = 1706400000;

  // Helper to create a fake BLS signature
  const fakeBLSSignature = new Uint8Array(BLS_SIGNATURE_SIZE).fill(0xab);

  // Helper to create test messages
  function createMessage(
    author: Address,
    timestamp: number,
    nonce: number,
    content: string
  ): SignedMessage {
    return {
      author,
      timestamp,
      nonce,
      content,
      signature: fakeBLSSignature,
      signatureType: 'bls',
    };
  }

  describe('buildAuthorTable', () => {
    it('should extract unique authors', () => {
      const messages: SignedMessage[] = [
        createMessage(author1, baseTimestamp, 0, 'Message 1'),
        createMessage(author2, baseTimestamp, 0, 'Message 2'),
        createMessage(author1, baseTimestamp + 10, 1, 'Message 3'),
        createMessage(author3, baseTimestamp + 20, 0, 'Message 4'),
      ];

      const authorTable = buildAuthorTable(messages);

      expect(authorTable.length).toBe(3);
      expect(authorTable).toContain(author1.toLowerCase());
      expect(authorTable).toContain(author2.toLowerCase());
      expect(authorTable).toContain(author3.toLowerCase());
    });

    it('should sort authors', () => {
      const messages: SignedMessage[] = [
        createMessage(author3, baseTimestamp, 0, 'Message 1'),
        createMessage(author1, baseTimestamp, 0, 'Message 2'),
        createMessage(author2, baseTimestamp, 0, 'Message 3'),
      ];

      const authorTable = buildAuthorTable(messages);

      // Should be sorted alphabetically
      expect(authorTable[0].toLowerCase()).toBe(author1.toLowerCase());
      expect(authorTable[1].toLowerCase()).toBe(author2.toLowerCase());
      expect(authorTable[2].toLowerCase()).toBe(author3.toLowerCase());
    });

    it('should handle single author', () => {
      const messages: SignedMessage[] = [
        createMessage(author1, baseTimestamp, 0, 'Message 1'),
        createMessage(author1, baseTimestamp + 10, 1, 'Message 2'),
        createMessage(author1, baseTimestamp + 20, 2, 'Message 3'),
      ];

      const authorTable = buildAuthorTable(messages);

      expect(authorTable.length).toBe(1);
      expect(authorTable[0].toLowerCase()).toBe(author1.toLowerCase());
    });
  });

  describe('encodeBatch', () => {
    it('should encode a small batch', () => {
      const messages: SignedMessage[] = [
        createMessage(author1, baseTimestamp, 0, 'Hello, world!'),
        createMessage(author2, baseTimestamp + 10, 0, 'Second message'),
      ];

      const encoded = encodeBatch(messages, { compress: false });

      expect(encoded.data.length).toBeGreaterThan(0);
      expect(encoded.messageCount).toBe(2);
      expect(encoded.authorCount).toBe(2);
      expect(encoded.totalSize).toBeLessThan(1000); // Should be small
    });

    it('should have correct magic number', () => {
      const messages: SignedMessage[] = [createMessage(author1, baseTimestamp, 0, 'Test message')];

      const encoded = encodeBatch(messages, { compress: false });
      const view = new DataView(
        encoded.data.buffer,
        encoded.data.byteOffset,
        encoded.data.byteLength
      );

      expect(view.getUint32(0, false)).toBe(MAGIC_BATCH);
    });

    it('should have correct version', () => {
      const messages: SignedMessage[] = [createMessage(author1, baseTimestamp, 0, 'Test message')];

      const encoded = encodeBatch(messages, { compress: false });
      expect(encoded.data[4]).toBe(PROTOCOL_VERSION);
    });

    it('should reject empty batch', () => {
      expect(() => encodeBatch([], { compress: false })).toThrow('Cannot create empty batch');
    });

    it('should handle messages from same author', () => {
      const messages: SignedMessage[] = [
        createMessage(author1, baseTimestamp, 0, 'Message 1'),
        createMessage(author1, baseTimestamp + 10, 1, 'Message 2'),
        createMessage(author1, baseTimestamp + 20, 2, 'Message 3'),
      ];

      const encoded = encodeBatch(messages, { compress: false });

      expect(encoded.messageCount).toBe(3);
      expect(encoded.authorCount).toBe(1);
    });

    it('should handle batch with many authors', () => {
      const messages: SignedMessage[] = [];
      for (let i = 0; i < 50; i++) {
        const author = `0x${i.toString(16).padStart(40, '0')}` as Address;
        messages.push(createMessage(author, baseTimestamp + i, 0, `Message ${i}`));
      }

      const encoded = encodeBatch(messages, { compress: false });

      expect(encoded.messageCount).toBe(50);
      expect(encoded.authorCount).toBe(50);
    });

    it('should throw on blob size overflow', () => {
      // Create many large messages to exceed blob limit
      const messages: SignedMessage[] = [];
      const largeContent = 'x'.repeat(1000);

      for (let i = 0; i < 200; i++) {
        const author = `0x${i.toString(16).padStart(40, '0')}` as Address;
        messages.push(createMessage(author, baseTimestamp + i, 0, largeContent));
      }

      expect(() => encodeBatch(messages, { compress: false })).toThrow(BatchOverflowError);
    });
  });

  describe('decodeBatch', () => {
    it('should decode an encoded batch', () => {
      const messages: SignedMessage[] = [
        createMessage(author1, baseTimestamp, 0, 'Hello, world!'),
        createMessage(author2, baseTimestamp + 10, 0, 'Second message'),
        createMessage(author1, baseTimestamp + 20, 1, 'Third message'),
      ];

      const encoded = encodeBatch(messages, { compress: false });
      const decoded = decodeBatch(encoded.data);

      expect(decoded.messages.length).toBe(3);
      expect(decoded.header.authors.length).toBe(2);
    });

    it('should preserve message content', () => {
      const messages: SignedMessage[] = [
        createMessage(author1, baseTimestamp, 0, 'Test message content'),
      ];

      const encoded = encodeBatch(messages, { compress: false });
      const decoded = decodeBatch(encoded.data);

      expect(decoded.messages[0].content).toBe('Test message content');
    });

    it('should preserve author addresses', () => {
      const messages: SignedMessage[] = [
        createMessage(author1, baseTimestamp, 0, 'Message 1'),
        createMessage(author2, baseTimestamp + 10, 0, 'Message 2'),
      ];

      const encoded = encodeBatch(messages, { compress: false });
      const decoded = decodeBatch(encoded.data);

      expect(decoded.messages[0].author.toLowerCase()).toBe(author1.toLowerCase());
      expect(decoded.messages[1].author.toLowerCase()).toBe(author2.toLowerCase());
    });

    it('should preserve timestamps', () => {
      const messages: SignedMessage[] = [
        createMessage(author1, baseTimestamp, 0, 'Message 1'),
        createMessage(author1, baseTimestamp + 100, 1, 'Message 2'),
        createMessage(author1, baseTimestamp + 500, 2, 'Message 3'),
      ];

      const encoded = encodeBatch(messages, { compress: false });
      const decoded = decodeBatch(encoded.data);

      expect(decoded.messages[0].timestamp).toBe(baseTimestamp);
      expect(decoded.messages[1].timestamp).toBe(baseTimestamp + 100);
      expect(decoded.messages[2].timestamp).toBe(baseTimestamp + 500);
    });

    it('should preserve nonces', () => {
      const messages: SignedMessage[] = [
        createMessage(author1, baseTimestamp, 0, 'Message 1'),
        createMessage(author1, baseTimestamp + 10, 1, 'Message 2'),
        createMessage(author1, baseTimestamp + 20, 42, 'Message 3'),
      ];

      const encoded = encodeBatch(messages, { compress: false });
      const decoded = decodeBatch(encoded.data);

      expect(decoded.messages[0].nonce).toBe(0);
      expect(decoded.messages[1].nonce).toBe(1);
      expect(decoded.messages[2].nonce).toBe(42);
    });

    it('should handle Unicode content', () => {
      const messages: SignedMessage[] = [
        createMessage(author1, baseTimestamp, 0, 'Hello 世界! 🌍🚀'),
      ];

      const encoded = encodeBatch(messages, { compress: false });
      const decoded = decodeBatch(encoded.data);

      expect(decoded.messages[0].content).toBe('Hello 世界! 🌍🚀');
    });
  });

  describe('estimateBatchSize', () => {
    it('should estimate batch size', () => {
      const messages: SignedMessage[] = [
        createMessage(author1, baseTimestamp, 0, 'Hello'),
        createMessage(author2, baseTimestamp + 10, 0, 'World'),
      ];

      const estimate = estimateBatchSize(messages, { compress: false });

      expect(estimate).toBeGreaterThan(0);
      expect(estimate).toBeLessThan(1000);
    });

    it('should account for compression', () => {
      const messages: SignedMessage[] = [createMessage(author1, baseTimestamp, 0, 'Test message')];

      const uncompressedEstimate = estimateBatchSize(messages, {
        compress: false,
      });
      const compressedEstimate = estimateBatchSize(messages, {
        compress: true,
      });

      expect(compressedEstimate).toBeLessThan(uncompressedEstimate);
    });
  });

  describe('validateBatch', () => {
    it('should validate valid batch', () => {
      const messages: SignedMessage[] = [
        createMessage(author1, baseTimestamp, 0, 'Message 1'),
        createMessage(author2, baseTimestamp + 10, 0, 'Message 2'),
      ];

      expect(validateBatch(messages)).toBe(true);
    });

    it('should reject empty batch', () => {
      expect(() => validateBatch([])).toThrow('at least one message');
    });

    it('should reject batch with timestamp delta overflow', () => {
      const messages: SignedMessage[] = [
        createMessage(author1, baseTimestamp, 0, 'Message 1'),
        createMessage(author1, baseTimestamp + 70000, 1, 'Message 2'),
      ];

      expect(() => validateBatch(messages)).toThrow('Timestamp delta');
    });
  });

  describe('round-trip encoding', () => {
    it('should successfully round-trip a typical batch', () => {
      const messages: SignedMessage[] = [
        createMessage(author1, baseTimestamp, 0, 'First message'),
        createMessage(author2, baseTimestamp + 10, 0, 'Second message'),
        createMessage(author3, baseTimestamp + 20, 0, 'Third message'),
        createMessage(author1, baseTimestamp + 30, 1, 'Fourth message'),
        createMessage(author2, baseTimestamp + 40, 1, 'Fifth message'),
      ];

      const encoded = encodeBatch(messages, { compress: false });
      const decoded = decodeBatch(encoded.data);

      expect(decoded.messages.length).toBe(messages.length);

      for (let i = 0; i < messages.length; i++) {
        expect(decoded.messages[i].author.toLowerCase()).toBe(messages[i].author.toLowerCase());
        expect(decoded.messages[i].timestamp).toBe(messages[i].timestamp);
        expect(decoded.messages[i].nonce).toBe(messages[i].nonce);
        expect(decoded.messages[i].content).toBe(messages[i].content);
      }
    });
  });

  describe('decodeBatch with batchStartOffset', () => {
    it('should return batchStartOffset of 0 by default', () => {
      const messages: SignedMessage[] = [createMessage(author1, baseTimestamp, 0, 'Test message')];

      const encoded = encodeBatch(messages, { compress: false });
      const decoded = decodeBatch(encoded.data);

      expect(decoded.batchStartOffset).toBe(0);
    });

    it('should accept batchStartOffset as second parameter (options)', () => {
      const messages: SignedMessage[] = [createMessage(author1, baseTimestamp, 0, 'Test message')];

      const encoded = encodeBatch(messages, { compress: false });
      const decoded = decodeBatch(encoded.data, { batchStartOffset: 100 });

      expect(decoded.batchStartOffset).toBe(100);
    });

    it('should accept batchStartOffset as third parameter (with dictionary)', () => {
      const messages: SignedMessage[] = [createMessage(author1, baseTimestamp, 0, 'Test message')];

      const encoded = encodeBatch(messages, { compress: false });
      // When dictionary is undefined, third param can still be options
      const decoded = decodeBatch(encoded.data, undefined, {
        batchStartOffset: 200,
      });

      expect(decoded.batchStartOffset).toBe(200);
    });
  });
});
