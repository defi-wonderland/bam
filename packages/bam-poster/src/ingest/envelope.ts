import type { Address, Bytes32 } from 'bam-sdk';
import type { Hex } from 'viem';

// Hoisted so every ingest call doesn't allocate a fresh decoder.
const TEXT_DECODER = new TextDecoder();

/**
 * Wire format accepted at the Poster's ingest boundary:
 *
 *     {
 *       "contentTag": "0x<32 bytes>",
 *       "message": {
 *         "sender":    "0x<20 bytes>",
 *         "nonce":     decimal-string | hex-string | number,
 *         "contents":  "0x<>=32 bytes>",
 *         "signature": "0x<65 bytes>"
 *       }
 *     }
 *
 * `contentTag` MUST equal `contents[0..32]` — that check is the
 * pipeline's `checkContentTag` stage; this parser only validates
 * structure. `contents.length >= 32` is enforced here to guarantee a
 * tag prefix exists to inspect.
 */
export interface MessageEnvelope {
  contentTag: Bytes32;
  message: {
    sender: Address;
    nonce: bigint;
    contents: Uint8Array;
    signature: Uint8Array;
  };
}

export type ParseResult =
  | { ok: true; envelope: MessageEnvelope }
  | { ok: false; result: { ok: false; reason: 'malformed' } };

/**
 * Parse the raw bytes into the envelope shape. Rejects with
 * `malformed` on any structural problem — no free-form text crosses
 * the library boundary.
 */
export function parseEnvelope(raw: Uint8Array): ParseResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(TEXT_DECODER.decode(raw));
  } catch {
    return { ok: false, result: { ok: false, reason: 'malformed' } };
  }
  if (!isObject(decoded)) {
    return { ok: false, result: { ok: false, reason: 'malformed' } };
  }
  const { contentTag, message } = decoded as Record<string, unknown>;
  if (!isBytes32(contentTag)) {
    return { ok: false, result: { ok: false, reason: 'malformed' } };
  }
  if (!isObject(message)) {
    return { ok: false, result: { ok: false, reason: 'malformed' } };
  }
  const { sender, nonce, contents, signature } = message as Record<string, unknown>;
  if (!isAddress(sender)) return { ok: false, result: { ok: false, reason: 'malformed' } };

  const parsedNonce = parseNonce(nonce);
  if (parsedNonce === null) return { ok: false, result: { ok: false, reason: 'malformed' } };

  const contentsBytes = parseHexBytes(contents);
  if (contentsBytes === null || contentsBytes.length < 32) {
    return { ok: false, result: { ok: false, reason: 'malformed' } };
  }

  const sigBytes = parseHexBytes(signature);
  if (sigBytes === null || sigBytes.length !== 65) {
    return { ok: false, result: { ok: false, reason: 'malformed' } };
  }

  return {
    ok: true,
    envelope: {
      contentTag,
      message: {
        sender,
        nonce: parsedNonce,
        contents: contentsBytes,
        signature: sigBytes,
      },
    },
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isHexPrefixed(v: unknown, lengthBytes: number): v is Hex {
  if (typeof v !== 'string') return false;
  const expected = 2 + lengthBytes * 2;
  if (v.length !== expected) return false;
  return /^0x[0-9a-fA-F]+$/.test(v);
}

function isBytes32(v: unknown): v is Bytes32 {
  return isHexPrefixed(v, 32);
}

function isAddress(v: unknown): v is Address {
  return isHexPrefixed(v, 20);
}

function parseNonce(v: unknown): bigint | null {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string') {
    if (/^[0-9]+$/.test(v)) return BigInt(v);
    if (/^0x[0-9a-fA-F]+$/.test(v)) {
      try {
        const n = BigInt(v);
        if (n >= 0n) return n;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Parse a `0x`-prefixed hex string (or bare hex) into bytes.
 * Returns `null` on any structural problem — odd length, non-hex chars.
 */
function parseHexBytes(v: unknown): Uint8Array | null {
  if (typeof v !== 'string') return null;
  const hex = v.startsWith('0x') ? v.slice(2) : v;
  if (!/^[0-9a-fA-F]*$/.test(hex)) return null;
  if (hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}
