/**
 * BPE (Byte-Pair Encoding) Compression Codec
 * @module bam-sdk/bpe
 *
 * Pure TypeScript implementation of a 12-bit BPE codec.
 * Ported from SocialBlobs/bpe_encode.py.
 *
 * Code layout (4096 codes total):
 *   0-1023:    4-byte tokens (most frequent)
 *   1024-2047: 3-byte tokens
 *   2048-3071: 2-byte tokens
 *   3072-4095: 1-byte tokens (all 256 byte values always present)
 *
 * Two 12-bit codes are packed into each 3-byte word:
 *   word = (code1 << 12) | code2
 */

/** Number of codes per tier */
const CODES_PER_TIER = 1024;

/** Total codes in dictionary */
const TOTAL_CODES = 4096;

/** Total dictionary bytes: 1024*4 + 1024*3 + 1024*2 + 1024*1 = 10240 */
const DICT_BYTES_SIZE = 10240;

/**
 * A compiled BPE dictionary ready for encoding/decoding.
 */
export interface BPEDictionary {
  /** Map from token (as hex key) to 12-bit code */
  tokenToCode: Map<string, number>;
  /** Concatenated token bytes (10240 bytes) */
  dictBytes: Uint8Array;
  /** Offset of each code's token in dictBytes */
  dictOffsets: Uint16Array;
  /** Length of each code's token */
  dictLengths: Uint8Array;
}

/**
 * Convert a byte sequence to a hex string key for Map lookup.
 */
function toKey(data: Uint8Array, start: number, length: number): string {
  let key = '';
  for (let i = start; i < start + length; i++) {
    key += String.fromCharCode(data[i]);
  }
  return key;
}

/**
 * Count all n-byte windows (n=2,3,4) in a corpus.
 */
function countWindows(data: Uint8Array): Map<string, number>[] {
  const counts: Map<string, number>[] = [
    new Map(), // 2-byte
    new Map(), // 3-byte
    new Map(), // 4-byte
  ];

  for (let L = 2; L <= 4; L++) {
    const map = counts[L - 2];
    for (let i = 0; i <= data.length - L; i++) {
      const key = toKey(data, i, L);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
  }

  return counts;
}

/**
 * Pick the top-1024 tokens for each length tier and assign codes.
 */
function topTokens(
  counts: Map<string, number>[],
  topN: number = CODES_PER_TIER
): Map<string, number> {
  const tokenToCode = new Map<string, number>();

  // Code 0 = null padding token (4 zero bytes)
  tokenToCode.set('\0\0\0\0', 0);

  // 4-byte tokens (codes 1..1023)
  let code = 1;
  const top4 = [...counts[2].entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN - 1);
  for (const [tok] of top4) {
    tokenToCode.set(tok, code++);
  }
  code = topN; // jump to 1024

  // 3-byte tokens (codes 1024..2047)
  const top3 = [...counts[1].entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN);
  for (const [tok] of top3) {
    tokenToCode.set(tok, code++);
  }
  code = topN * 2; // jump to 2048

  // 2-byte tokens (codes 2048..3071)
  const top2 = [...counts[0].entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN);
  for (const [tok] of top2) {
    tokenToCode.set(tok, code++);
  }
  code = topN * 3; // jump to 3072

  // 1-byte tokens (codes 3072..3327) — all 256 byte values
  for (let i = 0; i < 256; i++) {
    tokenToCode.set(String.fromCharCode(i), code++);
  }

  return tokenToCode;
}

/**
 * Build the binary dictionary blobs from the token-to-code mapping.
 */
function makeDictBlobs(tokenToCode: Map<string, number>): {
  dictBytes: Uint8Array;
  dictOffsets: Uint16Array;
  dictLengths: Uint8Array;
} {
  const dictBytes = new Uint8Array(DICT_BYTES_SIZE);
  const dictOffsets = new Uint16Array(TOTAL_CODES);
  const dictLengths = new Uint8Array(TOTAL_CODES);

  // Group by token length
  const groups: { tok: string; code: number }[][] = [[], [], [], []]; // indices 0-3 for lengths 1-4
  for (const [tok, code] of tokenToCode) {
    groups[tok.length - 1].push({ tok, code });
  }

  // Write tokens contiguously: 4-byte, 3-byte, 2-byte, 1-byte
  let pos = 0;
  for (const length of [4, 3, 2, 1]) {
    const group = groups[length - 1].sort((a, b) => a.code - b.code);
    for (const { tok, code } of group) {
      dictOffsets[code] = pos;
      dictLengths[code] = length;
      for (let i = 0; i < length; i++) {
        dictBytes[pos + i] = tok.charCodeAt(i);
      }
      pos += length;
    }
  }

  return { dictBytes, dictOffsets, dictLengths };
}

/**
 * Build a BPE dictionary from a corpus buffer.
 *
 * @param corpus Raw bytes to analyze for frequent n-grams
 * @returns Compiled BPE dictionary
 */
export function buildDictionary(corpus: Uint8Array): BPEDictionary {
  const counts = countWindows(corpus);
  const tokenToCode = topTokens(counts);
  const { dictBytes, dictOffsets, dictLengths } = makeDictBlobs(tokenToCode);

  return { tokenToCode, dictBytes, dictOffsets: dictOffsets, dictLengths: dictLengths };
}

/**
 * Serialize a BPE dictionary to a binary blob for storage/transmission.
 *
 * Format:
 *   [0..10239]        dictBytes (token data)
 *   [10240..18431]    dictOffsets (4096 x uint16, big-endian)
 *   [18432..22527]    dictLengths (4096 x uint8)
 *   Total: 22528 bytes
 */
export const BPE_SERIALIZED_SIZE = DICT_BYTES_SIZE + TOTAL_CODES * 2 + TOTAL_CODES;

export function serializeDictionary(dict: BPEDictionary): Uint8Array {
  const buf = new Uint8Array(BPE_SERIALIZED_SIZE);
  buf.set(dict.dictBytes, 0);

  // Write offsets as big-endian uint16
  const view = new DataView(buf.buffer);
  for (let i = 0; i < TOTAL_CODES; i++) {
    view.setUint16(DICT_BYTES_SIZE + i * 2, dict.dictOffsets[i], false);
  }

  // Write lengths
  buf.set(dict.dictLengths, DICT_BYTES_SIZE + TOTAL_CODES * 2);

  return buf;
}

/**
 * Deserialize a BPE dictionary from a binary blob.
 */
export function deserializeDictionary(data: Uint8Array): BPEDictionary {
  if (data.length < BPE_SERIALIZED_SIZE) {
    throw new Error(
      `BPE dictionary too small: ${data.length} bytes (expected ${BPE_SERIALIZED_SIZE})`
    );
  }

  const dictBytes = data.slice(0, DICT_BYTES_SIZE);
  const dictOffsets = new Uint16Array(TOTAL_CODES);
  const dictLengths = data.slice(DICT_BYTES_SIZE + TOTAL_CODES * 2, BPE_SERIALIZED_SIZE);

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < TOTAL_CODES; i++) {
    dictOffsets[i] = view.getUint16(DICT_BYTES_SIZE + i * 2, false);
  }

  // Rebuild tokenToCode from the binary representation
  const tokenToCode = new Map<string, number>();
  for (let code = 0; code < TOTAL_CODES; code++) {
    const len = dictLengths[code];
    if (len === 0) continue;
    const offset = dictOffsets[code];
    const key = toKey(dictBytes, offset, len);
    tokenToCode.set(key, code);
  }

  return {
    tokenToCode,
    dictBytes,
    dictOffsets,
    dictLengths: new Uint8Array(dictLengths),
  };
}

/**
 * Compress data using BPE encoding.
 *
 * Greedy longest-match: at each position try 4-byte, 3-byte, 2-byte,
 * then fall back to 1-byte. Two 12-bit codes are packed per 3-byte word.
 *
 * @param data Data to compress
 * @param dict BPE dictionary
 * @returns Compressed bytes (length is always a multiple of 3)
 */
export function bpeEncode(data: Uint8Array, dict: BPEDictionary): Uint8Array {
  const { tokenToCode } = dict;
  const codes: number[] = [];
  let i = 0;
  const len = data.length;

  while (i < len) {
    // Try 4-byte
    if (i + 4 <= len) {
      const key = toKey(data, i, 4);
      const code = tokenToCode.get(key);
      if (code !== undefined && code > 0) {
        codes.push(code);
        i += 4;
        continue;
      }
    }

    // Try 3-byte
    if (i + 3 <= len) {
      const key = toKey(data, i, 3);
      const code = tokenToCode.get(key);
      if (code !== undefined) {
        codes.push(code);
        i += 3;
        continue;
      }
    }

    // Try 2-byte
    if (i + 2 <= len) {
      const key = toKey(data, i, 2);
      const code = tokenToCode.get(key);
      if (code !== undefined) {
        codes.push(code);
        i += 2;
        continue;
      }
    }

    // Fallback: 1-byte (always exists for all 256 values)
    codes.push(tokenToCode.get(String.fromCharCode(data[i]))!);
    i += 1;
  }

  // Pad to even number of codes (code 0 = padding token)
  if (codes.length % 2 !== 0) {
    codes.push(0);
  }

  // Pack pairs of 12-bit codes into 3-byte words
  const out = new Uint8Array((codes.length / 2) * 3);
  for (let j = 0; j < codes.length; j += 2) {
    const word = (codes[j] << 12) | codes[j + 1];
    const idx = (j / 2) * 3;
    out[idx] = (word >> 16) & 0xff;
    out[idx + 1] = (word >> 8) & 0xff;
    out[idx + 2] = word & 0xff;
  }

  return out;
}

/**
 * Decompress BPE-encoded data.
 *
 * Reads pairs of 12-bit codes from 3-byte words, looks up each code
 * in the dictionary, and concatenates the corresponding tokens.
 *
 * @param data Compressed data (length must be a multiple of 3)
 * @param dict BPE dictionary
 * @returns Decompressed bytes
 */
export function bpeDecode(data: Uint8Array, dict: BPEDictionary): Uint8Array {
  if (data.length % 3 !== 0) {
    throw new Error(`BPE data length must be a multiple of 3, got ${data.length}`);
  }

  const { dictBytes, dictOffsets, dictLengths } = dict;

  // First pass: calculate output size
  let totalLen = 0;
  for (let i = 0; i < data.length; i += 3) {
    const word = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    const code1 = (word >> 12) & 0xfff;
    const code2 = word & 0xfff;
    totalLen += dictLengths[code1] + dictLengths[code2];
  }

  // Second pass: write output
  const out = new Uint8Array(totalLen);
  let pos = 0;

  for (let i = 0; i < data.length; i += 3) {
    const word = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    const code1 = (word >> 12) & 0xfff;
    const code2 = word & 0xfff;

    const off1 = dictOffsets[code1];
    const len1 = dictLengths[code1];
    for (let j = 0; j < len1; j++) {
      out[pos++] = dictBytes[off1 + j];
    }

    const off2 = dictOffsets[code2];
    const len2 = dictLengths[code2];
    for (let j = 0; j < len2; j++) {
      out[pos++] = dictBytes[off2 + j];
    }
  }

  return out;
}
