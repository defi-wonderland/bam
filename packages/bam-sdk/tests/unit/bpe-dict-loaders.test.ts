import { describe, it, expect } from 'vitest';
import { keccak256, type Address, type PublicClient } from 'viem';
import {
  bpeDecode,
  bpeDictionaryFromBytes,
  bpeEncode,
  buildBPEDictionary,
  bytesToHex,
  loadBPEDictionaryFromChain,
} from '../../src/index.js';

const CORPUS = new TextEncoder().encode(
  [
    'the quick brown fox jumps over the lazy dog. ',
    'sphinx of black quartz, judge my vow. ',
    'pack my box with five dozen liquor jugs. ',
  ]
    .join('')
    .repeat(80)
);

function bytesToHexNoPrefix(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

describe('bpeDictionaryFromBytes', () => {
  it('rejects wrong-size input', () => {
    expect(() => bpeDictionaryFromBytes(new Uint8Array(100))).toThrow();
  });

  it('roundtrips encode/decode against a corpus-built dict', () => {
    const original = buildBPEDictionary(CORPUS);
    const reconstructed = bpeDictionaryFromBytes(original.dictBytes);

    // Dict bytes preserved exactly.
    expect(bytesToHex(reconstructed.dictBytes)).toBe(bytesToHex(original.dictBytes));

    const inputs = [
      'the quick brown fox',
      'sphinx of black quartz, judge my vow',
      'gm wagmi lfg',
      'pack my box with five dozen liquor jugs',
    ];

    for (const text of inputs) {
      const bytes = new TextEncoder().encode(text);
      // Encode with reconstructed dict, decode with original (and vice versa).
      const a = bpeEncode(bytes, reconstructed);
      const aRound = bpeDecode(a, original);
      expect(new TextDecoder().decode(aRound)).toBe(text);

      const b = bpeEncode(bytes, original);
      const bRound = bpeDecode(b, reconstructed);
      expect(new TextDecoder().decode(bRound)).toBe(text);
    }
  });
});

// ─── Mock PublicClient that fakes the on-chain BPEDictionary ─────────────────

function buildMockClient(opts: {
  dictBytes: Uint8Array;
  identity: `0x${string}`;
  dictAddress?: Address;
  dictDataAddress?: Address;
  /** Override the code returned by getBytecode (defaults to STOP || dictBytes). */
  codeOverride?: Uint8Array;
}): { client: PublicClient; dictAddress: Address; dictDataAddress: Address } {
  const dictAddress = (opts.dictAddress ??
    '0x0000000000000000000000000000000000000d1c') as Address;
  const dictDataAddress = (opts.dictDataAddress ??
    '0x0000000000000000000000000000000000000da7') as Address;

  const stub = {
    async readContract({ functionName }: { functionName: string }) {
      if (functionName === 'DICT_DATA') return dictDataAddress;
      if (functionName === 'IDENTITY') return opts.identity;
      throw new Error(`unexpected readContract call: ${functionName}`);
    },
    async getBytecode({ address }: { address: Address }) {
      if (address.toLowerCase() !== dictDataAddress.toLowerCase()) {
        throw new Error(`unexpected getBytecode call: ${address}`);
      }
      const code = opts.codeOverride ?? new Uint8Array([0x00, ...opts.dictBytes]);
      return ('0x' + bytesToHexNoPrefix(code)) as `0x${string}`;
    },
  };

  return { client: stub as unknown as PublicClient, dictAddress, dictDataAddress };
}

describe('loadBPEDictionaryFromChain', () => {
  it('loads, verifies identity, and returns a usable dictionary', async () => {
    const corpusDict = buildBPEDictionary(CORPUS);
    const identity = keccak256(corpusDict.dictBytes);
    const { client, dictAddress, dictDataAddress } = buildMockClient({
      dictBytes: corpusDict.dictBytes,
      identity,
    });

    const loaded = await loadBPEDictionaryFromChain(client, dictAddress);

    expect(loaded.contractAddress).toBe(dictAddress);
    expect(loaded.dictDataAddress).toBe(dictDataAddress);
    expect(loaded.identity).toBe(identity);
    expect(bytesToHex(loaded.dictBytes)).toBe(bytesToHex(corpusDict.dictBytes));

    // Round-trips against the corpus dict.
    const text = 'the quick brown fox jumps over the lazy dog';
    const encoded = bpeEncode(new TextEncoder().encode(text), loaded);
    expect(new TextDecoder().decode(bpeDecode(encoded, corpusDict))).toBe(text);
  });

  it('throws on identity mismatch by default', async () => {
    const corpusDict = buildBPEDictionary(CORPUS);
    const wrongIdentity = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
    const { client, dictAddress } = buildMockClient({
      dictBytes: corpusDict.dictBytes,
      identity: wrongIdentity,
    });

    await expect(loadBPEDictionaryFromChain(client, dictAddress)).rejects.toThrow(
      /IDENTITY mismatch/
    );
  });

  it('allows opting out of identity verification', async () => {
    const corpusDict = buildBPEDictionary(CORPUS);
    const wrongIdentity = ('0x' + 'cd'.repeat(32)) as `0x${string}`;
    const { client, dictAddress } = buildMockClient({
      dictBytes: corpusDict.dictBytes,
      identity: wrongIdentity,
    });

    const loaded = await loadBPEDictionaryFromChain(client, dictAddress, {
      verifyIdentity: false,
    });
    expect(loaded.identity).toBe(wrongIdentity);
  });

  it('rejects a data contract whose code is the wrong size', async () => {
    const corpusDict = buildBPEDictionary(CORPUS);
    const identity = keccak256(corpusDict.dictBytes);
    const { client, dictAddress } = buildMockClient({
      dictBytes: corpusDict.dictBytes,
      identity,
      codeOverride: new Uint8Array([0x00, 0x01, 0x02]), // way too short
    });

    await expect(loadBPEDictionaryFromChain(client, dictAddress)).rejects.toThrow(
      /Unexpected dict data contract size/
    );
  });

  it('rejects a data contract whose first byte is not STOP', async () => {
    const corpusDict = buildBPEDictionary(CORPUS);
    const identity = keccak256(corpusDict.dictBytes);
    const bad = new Uint8Array(10241);
    bad[0] = 0x60; // not STOP
    bad.set(corpusDict.dictBytes, 1);
    const { client, dictAddress } = buildMockClient({
      dictBytes: corpusDict.dictBytes,
      identity,
      codeOverride: bad,
    });

    await expect(loadBPEDictionaryFromChain(client, dictAddress)).rejects.toThrow(
      /does not start with STOP/
    );
  });
});
