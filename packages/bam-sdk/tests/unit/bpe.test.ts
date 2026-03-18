/**
 * BPE codec tests
 */

import { describe, it, expect } from 'vitest';
import {
  bpeEncode,
  bpeDecode,
  buildBPEDictionary,
  serializeBPEDictionary,
  deserializeBPEDictionary,
  BPE_SERIALIZED_SIZE,
} from '../../src/index.js';

const textEncoder = new TextEncoder();

/**
 * Build a dictionary from a simple repeated corpus for testing.
 */
function buildTestDictionary() {
  // Repeat a representative corpus to get meaningful n-gram frequencies
  const corpus = textEncoder.encode(
    'Hello world! This is a test message. The quick brown fox jumps over the lazy dog. '
      .repeat(100)
  );
  return buildBPEDictionary(corpus);
}

describe('BPE Dictionary Building', () => {
  it('should build a dictionary from corpus', () => {
    const dict = buildTestDictionary();

    expect(dict.tokenToCode).toBeInstanceOf(Map);
    expect(dict.dictBytes).toBeInstanceOf(Uint8Array);
    expect(dict.dictBytes.length).toBe(10240);
    expect(dict.dictOffsets).toBeInstanceOf(Uint16Array);
    expect(dict.dictOffsets.length).toBe(4096);
    expect(dict.dictLengths).toBeInstanceOf(Uint8Array);
    expect(dict.dictLengths.length).toBe(4096);
  });

  it('should include all 256 single-byte tokens', () => {
    const dict = buildTestDictionary();

    for (let i = 0; i < 256; i++) {
      const key = String.fromCharCode(i);
      expect(dict.tokenToCode.has(key)).toBe(true);
      const code = dict.tokenToCode.get(key)!;
      // 1-byte codes are in range 3072-4095
      expect(code).toBeGreaterThanOrEqual(3072);
      expect(code).toBeLessThan(4096);
    }
  });

  it('should assign code 0 to padding token', () => {
    const dict = buildTestDictionary();
    expect(dict.tokenToCode.get('\0\0\0\0')).toBe(0);
  });
});

describe('BPE Serialization', () => {
  it('should serialize to correct size', () => {
    const dict = buildTestDictionary();
    const serialized = serializeBPEDictionary(dict);
    expect(serialized.length).toBe(BPE_SERIALIZED_SIZE);
  });

  it('should round-trip through serialize/deserialize', () => {
    const dict = buildTestDictionary();
    const serialized = serializeBPEDictionary(dict);
    const restored = deserializeBPEDictionary(serialized);

    expect(restored.dictBytes).toEqual(dict.dictBytes);
    expect(restored.dictOffsets).toEqual(dict.dictOffsets);
    expect(restored.dictLengths).toEqual(dict.dictLengths);
    expect(restored.tokenToCode.size).toBe(dict.tokenToCode.size);
  });

  it('should reject too-small data', () => {
    expect(() => deserializeBPEDictionary(new Uint8Array(100))).toThrow('too small');
  });
});

describe('BPE Encode', () => {
  it('should produce output with length multiple of 3', () => {
    const dict = buildTestDictionary();
    const data = textEncoder.encode('Hello, world!');
    const encoded = bpeEncode(data, dict);

    expect(encoded.length % 3).toBe(0);
  });

  it('should compress data', () => {
    const dict = buildTestDictionary();
    const data = textEncoder.encode('The quick brown fox jumps over the lazy dog.');
    const encoded = bpeEncode(data, dict);

    // BPE should provide some compression on text that matches the corpus
    expect(encoded.length).toBeLessThanOrEqual(data.length);
  });

  it('should handle empty input', () => {
    const dict = buildTestDictionary();
    const encoded = bpeEncode(new Uint8Array(0), dict);
    expect(encoded.length).toBe(0);
  });

  it('should handle single byte', () => {
    const dict = buildTestDictionary();
    const encoded = bpeEncode(new Uint8Array([0x41]), dict); // 'A'
    expect(encoded.length).toBe(3); // 1 code + 1 padding = 2 codes = 1 word = 3 bytes
  });

  it('should be deterministic', () => {
    const dict = buildTestDictionary();
    const data = textEncoder.encode('deterministic test');
    const encoded1 = bpeEncode(data, dict);
    const encoded2 = bpeEncode(data, dict);
    expect(encoded1).toEqual(encoded2);
  });
});

describe('BPE Decode', () => {
  it('should reject input with length not multiple of 3', () => {
    const dict = buildTestDictionary();
    expect(() => bpeDecode(new Uint8Array([1, 2]), dict)).toThrow('multiple of 3');
  });

  it('should handle empty input', () => {
    const dict = buildTestDictionary();
    const decoded = bpeDecode(new Uint8Array(0), dict);
    expect(decoded.length).toBe(0);
  });
});

describe('BPE Round-trip', () => {
  const dict = buildTestDictionary();

  const testCases = [
    'Hello, world!',
    'The quick brown fox jumps over the lazy dog.',
    'This is a test message.',
    'Short',
    'a',
    'Hello world! This is a test message.',
  ];

  for (const text of testCases) {
    it(`should round-trip: "${text.substring(0, 30)}..."`, () => {
      const data = textEncoder.encode(text);
      const encoded = bpeEncode(data, dict);
      const decoded = bpeDecode(encoded, dict);

      // Decoded output may have trailing padding bytes from code 0 (4-byte null token)
      // The actual message is a prefix of the decoded output
      const decodedStr = new TextDecoder().decode(decoded.slice(0, data.length));
      expect(decodedStr).toBe(text);
    });
  }

  it('should round-trip binary data', () => {
    const data = new Uint8Array(256);
    for (let i = 0; i < 256; i++) data[i] = i;

    const encoded = bpeEncode(data, dict);
    const decoded = bpeDecode(encoded, dict);

    // Check the original data is a prefix of decoded
    for (let i = 0; i < data.length; i++) {
      expect(decoded[i]).toBe(data[i]);
    }
  });
});

describe('BPE Batch Integration', () => {
  it('should work with encodeBatch/decodeBatch via codec option', async () => {
    const { encodeBatch, decodeBatch, BLS_SIGNATURE_SIZE } = await import('../../src/index.js');
    type Address = `0x${string}`;
    type SignedMessage = import('../../src/index.js').SignedMessage;

    const dict = buildTestDictionary();
    const serializedDict = serializeBPEDictionary(dict);

    const author1: Address = '0x1111111111111111111111111111111111111111';
    const author2: Address = '0x2222222222222222222222222222222222222222';
    const baseTimestamp = 1706400000;
    const fakeSig = new Uint8Array(BLS_SIGNATURE_SIZE).fill(0xab);

    const messages: SignedMessage[] = [
      { author: author1, timestamp: baseTimestamp, nonce: 0, content: 'Hello world! This is a test message.', signature: fakeSig, signatureType: 'bls' },
      { author: author2, timestamp: baseTimestamp + 10, nonce: 0, content: 'The quick brown fox jumps over the lazy dog.', signature: fakeSig, signatureType: 'bls' },
      { author: author1, timestamp: baseTimestamp + 20, nonce: 1, content: 'This is a test message.', signature: fakeSig, signatureType: 'bls' },
    ];

    // Encode with BPE compression
    const encoded = encodeBatch(messages, {
      codec: 'bpe',
      dictionary: serializedDict,
    });

    expect(encoded.messageCount).toBe(3);
    expect(encoded.compressionRatio).toBeGreaterThan(0);

    // Verify the compressed flag and codec byte are set
    expect(encoded.data[5] & 0x04).toBe(0x04); // BATCH_FLAG_COMPRESSED
    expect(encoded.data[6]).toBe(0x01); // CODEC_BPE

    // Decode with BPE — wrap serialized dict as ZstdDictionary-like object for the API
    const dictForDecode = { data: serializedDict, id: 0 };
    const decoded = decodeBatch(encoded.data, dictForDecode);

    expect(decoded.messages.length).toBe(3);
    expect(decoded.messages[0].content).toBe('Hello world! This is a test message.');
    expect(decoded.messages[1].content).toBe('The quick brown fox jumps over the lazy dog.');
    expect(decoded.messages[2].content).toBe('This is a test message.');
    expect(decoded.messages[0].author.toLowerCase()).toBe(author1.toLowerCase());
    expect(decoded.messages[1].author.toLowerCase()).toBe(author2.toLowerCase());
    expect(decoded.messages[0].timestamp).toBe(baseTimestamp);
    expect(decoded.messages[1].timestamp).toBe(baseTimestamp + 10);
    expect(decoded.messages[0].nonce).toBe(0);
    expect(decoded.messages[2].nonce).toBe(1);
  });
});
