import { describe, expect, it } from 'vitest';

import { decodeText } from '../src/components/ReaderMessagesPanel';

// Build a `contents` hex string with the same shape the BAM apps
// produce: 32-byte content tag prefix, then the app's payload.
// Returns the `0x`-prefixed hex.
function buildContents(payload: Uint8Array, tagByte = 0xaa): string {
  const tag = new Uint8Array(32).fill(tagByte);
  const out = new Uint8Array(tag.length + payload.length);
  out.set(tag, 0);
  out.set(payload, tag.length);
  return '0x' + Array.from(out, (b) => b.toString(16).padStart(2, '0')).join('');
}

function lenPrefixed(text: string): Uint8Array {
  const utf8 = new TextEncoder().encode(text);
  const out = new Uint8Array(4 + utf8.length);
  // u32 BE length prefix
  out[0] = (utf8.length >>> 24) & 0xff;
  out[1] = (utf8.length >>> 16) & 0xff;
  out[2] = (utf8.length >>> 8) & 0xff;
  out[3] = utf8.length & 0xff;
  out.set(utf8, 4);
  return out;
}

describe('decodeText — happy path', () => {
  it('decodes a simple length-prefixed UTF-8 trailing payload', () => {
    const payload = lenPrefixed('hello world');
    expect(decodeText(buildContents(payload))).toBe('hello world');
  });

  it('decodes a payload with leading non-text bytes followed by a trailing length-prefixed string', () => {
    const text = lenPrefixed('after preamble');
    const preamble = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
    const combined = new Uint8Array(preamble.length + text.length);
    combined.set(preamble, 0);
    combined.set(text, preamble.length);
    expect(decodeText(buildContents(combined))).toBe('after preamble');
  });

  it('decodes a multi-byte UTF-8 string', () => {
    const payload = lenPrefixed('héllo 🌍');
    expect(decodeText(buildContents(payload))).toBe('héllo 🌍');
  });
});

describe('decodeText — empty UTF-8 (len === 0) is valid', () => {
  it('returns the empty string when the trailing length is zero', () => {
    // App payload: u32 BE 0x00000000 with no following bytes.
    const payload = new Uint8Array([0, 0, 0, 0]);
    expect(decodeText(buildContents(payload))).toBe('');
  });
});

describe('decodeText — input validation', () => {
  it('returns null for non-string input', () => {
    expect(decodeText(undefined)).toBeNull();
    expect(decodeText(123)).toBeNull();
    expect(decodeText(null)).toBeNull();
    expect(decodeText({})).toBeNull();
  });

  it('returns null when missing 0x prefix', () => {
    expect(decodeText('abcd1234')).toBeNull();
  });

  it('returns null on odd-length hex', () => {
    expect(decodeText('0x123')).toBeNull();
  });

  it('returns null on non-hex chars (does not silently coerce NaN→0)', () => {
    // Includes a `g` — `parseInt('ag', 16)` is NaN, which would
    // become 0 in a Uint8Array. The fix should reject the whole
    // string instead of decoding a corrupted byte stream.
    const tag = '0x' + 'aa'.repeat(32);
    const trailing = '00000003zzzz'; // length 3 then non-hex
    expect(decodeText(tag + trailing)).toBeNull();
  });

  it('returns null when the buffer is shorter than the 32-byte tag plus a 4-byte length prefix', () => {
    expect(decodeText('0x' + 'aa'.repeat(35))).toBeNull();
  });
});

describe('decodeText — declines obviously-bad payloads', () => {
  it('returns null when no offset matches a length-prefixed UTF-8 string', () => {
    // App payload of garbage bytes — no offset has a valid (length, utf8) tail.
    const payload = new Uint8Array([0xff, 0xfe, 0xfd, 0xfc, 0xfb]);
    expect(decodeText(buildContents(payload))).toBeNull();
  });

  it('returns null on a length that runs past the end of the buffer', () => {
    // u32 BE 0x000000ff (255) with only 1 trailing byte.
    const payload = new Uint8Array([0, 0, 0, 0xff, 0x41]);
    expect(decodeText(buildContents(payload))).toBeNull();
  });
});

describe('decodeText — bounds work on oversized input', () => {
  it('returns null without allocating when contents exceeds the size cap', () => {
    // 16 KB of hex bytes is the cap; 16 KB + 1 byte (= 32 KB + 2
    // hex chars) is over. The function must reject this *before*
    // the regex or the Uint8Array allocation runs.
    const overCap = 16_384 + 1;
    const hugeHex = '0x' + '00'.repeat(overCap);
    const startedAt = Date.now();
    expect(decodeText(hugeHex)).toBeNull();
    // Generous bound — not a real perf test, just a tripwire if a
    // future regression makes the function materialize the whole
    // buffer first.
    expect(Date.now() - startedAt).toBeLessThan(50);
  });

  it('decodes payloads at exactly the cap', () => {
    // 16 KB total: 32-byte tag + (16384 - 32 - 4) zero preamble +
    // u32 length 0 + zero-length tail.
    const tail = new Uint8Array([0, 0, 0, 0]);
    const preamble = new Uint8Array(16_384 - 32 - tail.length);
    const payload = new Uint8Array(preamble.length + tail.length);
    payload.set(preamble, 0);
    payload.set(tail, preamble.length);
    expect(decodeText(buildContents(payload))).toBe('');
  });
});
