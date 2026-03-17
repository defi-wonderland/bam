/**
 * Integration tests for extended signature mode (SigType 11)
 * @see specs/008-signature-extensibility
 */

import { describe, it, expect } from 'vitest';
import {
  encodeMessage,
  decodeMessage,
  SignatureScheme,
  parseExtendedHeader,
  encodeExtendedHeader,
  getSignatureSizeForScheme,
  UnknownSignatureSchemeError,
  UnsupportedSchemeVersionError,
} from '../../src/index.js';
import type { SignedMessage, ExtendedSignatureHeader } from '../../src/index.js';

describe('Extended Signature Mode (SigType 11)', () => {
  const testAuthor = '0x1234567890123456789012345678901234567890' as const;
  const testTimestamp = 1706867200; // Fixed timestamp for reproducibility

  describe('backward compatibility', () => {
    it('should encode/decode ECDSA messages unchanged', () => {
      const msg: SignedMessage = {
        author: testAuthor,
        timestamp: testTimestamp,
        nonce: 1,
        content: 'ECDSA signed message',
        signature: new Uint8Array(65).fill(0xab),
        signatureType: 'ecdsa',
      };

      const encoded = encodeMessage(msg);
      const decoded = decodeMessage(encoded);

      expect(decoded.signatureType).toBe('ecdsa');
      expect(decoded.author).toBe(testAuthor);
      expect(decoded.content).toBe(msg.content);
      expect(decoded.extendedHeader).toBeUndefined();
    });

    it('should encode/decode BLS messages unchanged', () => {
      const msg: SignedMessage = {
        author: testAuthor,
        timestamp: testTimestamp,
        nonce: 2,
        content: 'BLS signed message',
        signature: new Uint8Array(48).fill(0xcd),
        signatureType: 'bls',
      };

      const encoded = encodeMessage(msg);
      const decoded = decodeMessage(encoded);

      expect(decoded.signatureType).toBe('bls');
      expect(decoded.author).toBe(testAuthor);
      expect(decoded.content).toBe(msg.content);
      expect(decoded.extendedHeader).toBeUndefined();
    });
  });

  describe('extended mode encoding/decoding', () => {
    it('should encode/decode extended BLS signature', () => {
      const msg: SignedMessage = {
        author: testAuthor,
        timestamp: testTimestamp,
        nonce: 3,
        content: 'Extended BLS signature',
        signature: new Uint8Array(48).fill(0xef),
        signatureType: 'extended',
        extendedHeader: {
          scheme: SignatureScheme.BLS,
          schemeVersion: 1,
        },
      };

      const encoded = encodeMessage(msg);
      const decoded = decodeMessage(encoded);

      expect(decoded.signatureType).toBe('extended');
      expect(decoded.extendedHeader).toBeDefined();
      expect(decoded.extendedHeader!.scheme).toBe(SignatureScheme.BLS);
      expect(decoded.extendedHeader!.schemeVersion).toBe(1);
      expect(decoded.content).toBe(msg.content);
    });

    it('should encode/decode extended ECDSA signature', () => {
      const msg: SignedMessage = {
        author: testAuthor,
        timestamp: testTimestamp,
        nonce: 4,
        content: 'Extended ECDSA signature',
        signature: new Uint8Array(65).fill(0x12),
        signatureType: 'extended',
        extendedHeader: {
          scheme: SignatureScheme.ECDSA,
          schemeVersion: 1,
        },
      };

      const encoded = encodeMessage(msg);
      const decoded = decodeMessage(encoded);

      expect(decoded.signatureType).toBe('extended');
      expect(decoded.extendedHeader).toBeDefined();
      expect(decoded.extendedHeader!.scheme).toBe(SignatureScheme.ECDSA);
      expect(decoded.extendedHeader!.schemeVersion).toBe(1);
    });

    it('should include 2-byte overhead for extended header', () => {
      const blsMsg: SignedMessage = {
        author: testAuthor,
        timestamp: testTimestamp,
        nonce: 5,
        content: 'Test message',
        signature: new Uint8Array(48).fill(0x00),
        signatureType: 'bls',
      };

      const extendedMsg: SignedMessage = {
        ...blsMsg,
        nonce: 6,
        signatureType: 'extended',
        extendedHeader: {
          scheme: SignatureScheme.BLS,
          schemeVersion: 1,
        },
      };

      const blsEncoded = encodeMessage(blsMsg);
      const extendedEncoded = encodeMessage(extendedMsg);

      expect(extendedEncoded.length).toBe(blsEncoded.length + 2);
    });
  });

  describe('extended header helpers', () => {
    it('should encode extended header correctly', () => {
      const header: ExtendedSignatureHeader = {
        scheme: SignatureScheme.BLS,
        schemeVersion: 1,
      };

      const encoded = encodeExtendedHeader(header);

      expect(encoded.length).toBe(2);
      expect(encoded[0]).toBe(0x02); // BLS scheme ID
      expect(encoded[1]).toBe(0x01); // Version 1
    });

    it('should parse extended header correctly', () => {
      const data = new Uint8Array([0x02, 0x01]); // BLS, version 1
      const parsed = parseExtendedHeader(data);

      expect(parsed.scheme).toBe(SignatureScheme.BLS);
      expect(parsed.schemeVersion).toBe(1);
    });

    it('should return correct signature sizes for schemes', () => {
      expect(getSignatureSizeForScheme(SignatureScheme.ECDSA)).toBe(65);
      expect(getSignatureSizeForScheme(SignatureScheme.BLS)).toBe(48);
    });
  });

  describe('error handling', () => {
    it('should reject unknown signature schemes', () => {
      const data = new Uint8Array([0x03, 0x01]); // STARK (not implemented)

      expect(() => parseExtendedHeader(data)).toThrow(UnknownSignatureSchemeError);
    });

    it('should reject unsupported scheme versions', () => {
      const data = new Uint8Array([0x02, 0x02]); // BLS, version 2 (unsupported)

      expect(() => parseExtendedHeader(data)).toThrow(UnsupportedSchemeVersionError);
    });

    it('should reject extended message without header', () => {
      const msg: SignedMessage = {
        author: testAuthor,
        timestamp: testTimestamp,
        nonce: 10,
        content: 'Missing header',
        signature: new Uint8Array(48).fill(0x00),
        signatureType: 'extended',
      };

      expect(() => encodeMessage(msg)).toThrow();
    });

    it('should reject truncated extended header', () => {
      const data = new Uint8Array([0x02]); // Only 1 byte

      expect(() => parseExtendedHeader(data)).toThrow();
    });
  });

  describe('round-trip integrity', () => {
    it('should preserve all fields through encode/decode cycle', () => {
      const original: SignedMessage = {
        author: testAuthor,
        timestamp: testTimestamp,
        nonce: 12345,
        content: 'Round-trip test with emoji 🚀',
        signature: new Uint8Array(48).map((_, i) => i % 256),
        signatureType: 'extended',
        extendedHeader: {
          scheme: SignatureScheme.BLS,
          schemeVersion: 1,
        },
      };

      const encoded = encodeMessage(original);
      const decoded = decodeMessage(encoded);

      expect(decoded.author).toBe(original.author);
      expect(decoded.timestamp).toBe(original.timestamp);
      expect(decoded.nonce).toBe(original.nonce);
      expect(decoded.content).toBe(original.content);
      expect(decoded.signatureType).toBe(original.signatureType);
      expect(decoded.extendedHeader?.scheme).toBe(original.extendedHeader?.scheme);
      expect(decoded.extendedHeader?.schemeVersion).toBe(original.extendedHeader?.schemeVersion);
      expect(Array.from(decoded.signature)).toEqual(Array.from(original.signature));
    });

    it('should handle reply-to with extended signature', () => {
      const replyTo =
        '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890' as const;

      const msg: SignedMessage = {
        author: testAuthor,
        timestamp: testTimestamp,
        nonce: 100,
        content: 'Reply with extended sig',
        signature: new Uint8Array(48).fill(0xff),
        signatureType: 'extended',
        extendedHeader: {
          scheme: SignatureScheme.BLS,
          schemeVersion: 1,
        },
        replyTo,
      };

      const encoded = encodeMessage(msg);
      const decoded = decodeMessage(encoded);

      expect(decoded.replyTo).toBe(replyTo);
      expect(decoded.signatureType).toBe('extended');
      expect(decoded.extendedHeader?.scheme).toBe(SignatureScheme.BLS);
    });
  });
});
