import { describe, it, expect } from 'vitest';
import { keccak256 } from 'viem';
import {
  BPE_V1_IDENTITY,
  bpeDecode,
  bpeEncode,
  bytesToHex,
  loadBundledBPEDictionary,
} from '../../src/index.js';

describe('loadBundledBPEDictionary', () => {
  it('loads the bundled v1 dict and its identity matches BPE_V1_IDENTITY', async () => {
    const dict = await loadBundledBPEDictionary();
    expect(dict.dictBytes.length).toBe(10_240);

    const local = keccak256(dict.dictBytes);
    expect(local.toLowerCase()).toBe(BPE_V1_IDENTITY.toLowerCase());
  });

  it('roundtrips realistic social-message inputs', async () => {
    const dict = await loadBundledBPEDictionary();
    const inputs = [
      'gm everyone',
      'just shipped a new thing',
      'wagmi',
      'check this out https://example.com/foo',
      'the quick brown fox jumps over the lazy dog',
    ];
    for (const text of inputs) {
      const bytes = new TextEncoder().encode(text);
      const encoded = bpeEncode(bytes, dict);
      const decoded = new TextDecoder().decode(bpeDecode(encoded, dict));
      expect(decoded).toBe(text);
    }
  });

  it('compresses better than 1:1 on typical social content', async () => {
    const dict = await loadBundledBPEDictionary();
    const text =
      'gm wagmi, the quick brown fox is jumping over the lazy dog this morning ' +
      'and you should check this out, it is awesome and you will love it.';
    const bytes = new TextEncoder().encode(text);
    const encoded = bpeEncode(bytes, dict);
    // Real ratio depends on the corpus, but should beat 1:1 on natural prose
    // that overlaps the training distribution.
    expect(encoded.length).toBeLessThan(bytes.length);
  });
});
