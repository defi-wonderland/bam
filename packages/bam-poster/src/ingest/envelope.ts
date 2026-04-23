import type { Address, Bytes32 } from 'bam-sdk';
import type { Hex } from 'viem';
import type { ValidationResult } from '../types.js';
import { canonicalTag } from '../util/canonical.js';

// Hoisted so every ingest call doesn't allocate a fresh decoder.
const TEXT_DECODER = new TextDecoder();

/**
 * Wire format accepted at the Poster's ingest boundary (plan §C-11):
 * a JSON envelope that bundles the signed v1 message together with the
 * caller-claimed `contentTag`.
 *
 * v1's ECDSA signing domain (ERC-8180 §Nonce Semantics, `messageHash =
 * keccak256(sender || nonce || contents)`) does not bind `contentTag`.
 * The envelope is the Poster's construction for treating contentTag as
 * the authoritative tag per spec §Goals — a hint at a different
 * transport layer can only disagree with it and be rejected.
 */
export interface MessageEnvelope {
  contentTag: Bytes32;
  message: {
    author: Address;
    timestamp: number;
    nonce: bigint;
    content: string;
    signature: Uint8Array;
  };
}

export type ParseResult =
  | { ok: true; envelope: MessageEnvelope }
  | { ok: false; result: Extract<ValidationResult, { ok: false }> };

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
  const { author, timestamp, nonce, content, signature } = message as Record<string, unknown>;
  if (!isAddress(author)) return { ok: false, result: { ok: false, reason: 'malformed' } };
  // The SDK packs `timestamp` as a uint32 via `DataView.setUint32`
  // (bam-sdk/src/message.ts). Allowing floats, negatives, or values
  // above 2^32-1 would silently wrap/truncate during hashing and
  // diverge from what the signer produced (cubic / qodo review).
  // Reject at parse time with a clear `malformed` reason.
  if (
    typeof timestamp !== 'number' ||
    !Number.isInteger(timestamp) ||
    timestamp < 0 ||
    timestamp > 0xffff_ffff
  ) {
    return { ok: false, result: { ok: false, reason: 'malformed' } };
  }
  const parsedNonce = parseNonce(nonce);
  if (parsedNonce === null) return { ok: false, result: { ok: false, reason: 'malformed' } };
  if (typeof content !== 'string') {
    return { ok: false, result: { ok: false, reason: 'malformed' } };
  }
  const sigBytes = parseSignature(signature);
  if (sigBytes === null) return { ok: false, result: { ok: false, reason: 'malformed' } };

  return {
    ok: true,
    envelope: {
      // Canonicalize contentTag here so downstream store queries (which
      // are case-sensitive TEXT equality) always see one representation.
      contentTag: canonicalTag(contentTag),
      message: {
        author,
        timestamp,
        nonce: parsedNonce,
        content,
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
    // Decimal first: "10" is ten, not sixteen. Only treat as hex when
    // the `0x` prefix is explicit.
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

function parseSignature(v: unknown): Uint8Array | null {
  if (typeof v !== 'string') return null;
  const hex = v.startsWith('0x') ? v.slice(2) : v;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  if (hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}
