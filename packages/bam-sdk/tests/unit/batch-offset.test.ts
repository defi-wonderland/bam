/**
 * Batch offset tests
 * Tests for batchStartOffset support in blob parsing and exposure
 */

import { describe, it, expect } from 'vitest';
import type { Address, SignedMessage } from '../../src/index.js';
import { BLS_SIGNATURE_SIZE, encodeBatch, decodeBatch } from '../../src/index.js';

describe('Batch Offset Support', () => {
  // Test data
  const author1: Address = '0x1111111111111111111111111111111111111111';
  const baseTimestamp = 1706400000;
  const fakeBLSSignature = new Uint8Array(BLS_SIGNATURE_SIZE).fill(0xab);

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

  describe('DecodedBatch.batchStartOffset', () => {
    it('should default to 0 when not specified', () => {
      const messages: SignedMessage[] = [createMessage(author1, baseTimestamp, 0, 'Test')];

      const encoded = encodeBatch(messages, { compress: false });
      const decoded = decodeBatch(encoded.data);

      expect(decoded.batchStartOffset).toBe(0);
    });

    it('should store custom offset value', () => {
      const messages: SignedMessage[] = [createMessage(author1, baseTimestamp, 0, 'Test')];

      const encoded = encodeBatch(messages, { compress: false });
      const decoded = decodeBatch(encoded.data, { batchStartOffset: 500 });

      expect(decoded.batchStartOffset).toBe(500);
    });

    it('should handle offset at field element boundaries', () => {
      const messages: SignedMessage[] = [createMessage(author1, baseTimestamp, 0, 'Test')];

      const encoded = encodeBatch(messages, { compress: false });

      // Test at FE boundaries: 31, 62, 93...
      const decoded31 = decodeBatch(encoded.data, { batchStartOffset: 31 });
      expect(decoded31.batchStartOffset).toBe(31);

      const decoded62 = decodeBatch(encoded.data, { batchStartOffset: 62 });
      expect(decoded62.batchStartOffset).toBe(62);

      const decoded93 = decodeBatch(encoded.data, { batchStartOffset: 93 });
      expect(decoded93.batchStartOffset).toBe(93);
    });

    it('should handle offset at max usable bytes boundary', () => {
      const messages: SignedMessage[] = [createMessage(author1, baseTimestamp, 0, 'Test')];

      const encoded = encodeBatch(messages, { compress: false });
      const maxOffset = 126000; // Near max but leaving room for batch

      const decoded = decodeBatch(encoded.data, {
        batchStartOffset: maxOffset,
      });
      expect(decoded.batchStartOffset).toBe(maxOffset);
    });
  });

  describe('Offset calculations', () => {
    it('should correctly map offsets to field elements', () => {
      // FE boundaries: 0-30, 31-61, 62-92, 93-123...
      const testCases = [
        { absoluteOffset: 0, expectedFE: 0 },
        { absoluteOffset: 30, expectedFE: 0 },
        { absoluteOffset: 31, expectedFE: 1 },
        { absoluteOffset: 62, expectedFE: 2 },
        { absoluteOffset: 93, expectedFE: 3 },
        { absoluteOffset: 100, expectedFE: 3 }, // floor(100/31) = 3
        { absoluteOffset: 1000, expectedFE: 32 }, // floor(1000/31) = 32
      ];

      for (const { absoluteOffset, expectedFE } of testCases) {
        const calculatedFE = Math.floor(absoluteOffset / 31);
        expect(calculatedFE).toBe(expectedFE);
      }
    });
  });

  describe('Field element boundary edge cases', () => {
    it('should handle message spanning multiple field elements', () => {
      // Message starting at byte 25 (FE 0) and ending at byte 45 (FE 1)
      const batchStartOffset = 25;
      const byteOffset = 0;
      const byteLength = 20;
      const absoluteStart = batchStartOffset + byteOffset; // 25
      const absoluteEnd = absoluteStart + byteLength - 1; // 44

      const startFE = Math.floor(absoluteStart / 31); // 0
      const endFE = Math.floor(absoluteEnd / 31); // 1
      const feCount = endFE - startFE + 1; // 2

      expect(startFE).toBe(0);
      expect(endFE).toBe(1);
      expect(feCount).toBe(2);
    });

    it('should handle message exactly within one field element', () => {
      // Message starting at byte 0 and ending at byte 30 (all within FE 0)
      const absoluteStart = 0;
      const byteLength = 31;
      const absoluteEnd = absoluteStart + byteLength - 1; // 30

      const startFE = Math.floor(absoluteStart / 31); // 0
      const endFE = Math.floor(absoluteEnd / 31); // 0
      const feCount = endFE - startFE + 1; // 1

      expect(startFE).toBe(0);
      expect(endFE).toBe(0);
      expect(feCount).toBe(1);
    });

    it('should handle message starting exactly at FE boundary', () => {
      // Message starting at byte 31 (start of FE 1)
      const batchStartOffset = 31;
      const byteOffset = 0;
      const byteLength = 10;
      const absoluteStart = batchStartOffset + byteOffset; // 31

      const startFE = Math.floor(absoluteStart / 31); // 1

      expect(startFE).toBe(1);
    });

    it('should handle message ending exactly at FE boundary', () => {
      // Message ending at byte 61 (last byte of FE 1)
      const absoluteStart = 50;
      const byteLength = 12;
      const absoluteEnd = absoluteStart + byteLength - 1; // 61

      const endFE = Math.floor(absoluteEnd / 31); // 1

      expect(endFE).toBe(1);
    });

    it('should handle large offset values correctly', () => {
      // Offset near the end of blob capacity
      const batchStartOffset = 100000;
      const byteOffset = 1000;
      const byteLength = 100;
      const absoluteStart = batchStartOffset + byteOffset; // 101000
      const absoluteEnd = absoluteStart + byteLength - 1; // 101099

      const startFE = Math.floor(absoluteStart / 31); // 3258
      const endFE = Math.floor(absoluteEnd / 31); // 3261

      expect(startFE).toBe(3258);
      expect(endFE).toBe(3261);
    });
  });

  describe('Backward compatibility', () => {
    it('should work with no offset specified (legacy behavior)', () => {
      const messages: SignedMessage[] = [createMessage(author1, baseTimestamp, 0, 'Test message')];

      const encoded = encodeBatch(messages, { compress: false });
      const decoded = decodeBatch(encoded.data);

      // Should default to 0
      expect(decoded.batchStartOffset).toBe(0);
      // Should still decode correctly
      expect(decoded.messages.length).toBe(1);
      expect(decoded.messages[0].content).toBe('Test message');
    });

    it('should produce same results with explicit 0 offset as no offset', () => {
      const messages: SignedMessage[] = [createMessage(author1, baseTimestamp, 0, 'Test message')];

      const encoded = encodeBatch(messages, { compress: false });
      const decodedDefault = decodeBatch(encoded.data);
      const decodedExplicit = decodeBatch(encoded.data, {
        batchStartOffset: 0,
      });

      expect(decodedDefault.batchStartOffset).toBe(decodedExplicit.batchStartOffset);
      expect(decodedDefault.messages.length).toBe(decodedExplicit.messages.length);
      expect(decodedDefault.messages[0].content).toBe(decodedExplicit.messages[0].content);
    });
  });
});
