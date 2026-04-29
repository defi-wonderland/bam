/**
 * Blobscan fallback blob fetch.
 *
 * The Reader treats Blobscan as a *fallback* — used only when the
 * primary beacon-API source returned `null` or rejected its bytes via
 * versioned-hash mismatch. Blobscan's API keys blobs by versioned hash,
 * but the Reader does not trust that keying: every successful fetch is
 * re-hashed locally and verified against the `BlobBatchRegistered`
 * event's `blobVersionedHash` (red-team C-2). A wrong-hash payload is
 * rejected the same way as a wrong-hash beacon sidecar.
 */

import type { Bytes32 } from 'bam-sdk';

import { assertVersionedHashMatches } from './versioned-hash.js';
import type { FetchLike } from './beacon.js';

export interface BlobscanFetchOptions {
  /** Base URL, e.g. `https://api.sepolia.blobscan.com`. No trailing slash required. */
  baseUrl: string;
  versionedHash: Bytes32;
  /** Optional injected `fetch` for tests; defaults to global `fetch`. */
  fetchImpl?: FetchLike;
}

function trimSlash(s: string): string {
  return s.replace(/\/$/, '');
}

function ensure0x(hex: string): string {
  return hex.startsWith('0x') ? hex : `0x${hex}`;
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (cleaned.length % 2 !== 0) {
    throw new RangeError('invalid hex (odd length)');
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Blobscan v2 (current at time of writing) returns metadata only and
 * points at one or more public storage URLs (`dataStorageReferences[].url`)
 * that serve the raw blob bytes. The Reader still hash-verifies the
 * fetched bytes against the requested versioned hash, so an attacker
 * substituting a malicious URL can only deny service, not forge content.
 */
function extractStorageUrls(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const refs = (data as Record<string, unknown>).dataStorageReferences;
  if (!Array.isArray(refs)) return [];
  const out: string[] = [];
  for (const ref of refs) {
    if (!ref || typeof ref !== 'object') continue;
    const url = (ref as { url?: unknown }).url;
    if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
      out.push(url);
    }
  }
  return out;
}

function extractBlobHex(data: unknown): string | null {
  if (typeof data === 'string' && /^0x[0-9a-fA-F]+$/.test(data)) return data;
  if (!data || typeof data !== 'object') return null;
  const o = data as Record<string, unknown>;
  const blob = o.blob;
  const candidates: unknown[] = [
    o.data,
    blob,
    o.blobData,
    typeof blob === 'object' && blob !== null
      ? (blob as Record<string, unknown>).data
      : undefined,
    typeof blob === 'object' && blob !== null
      ? (blob as Record<string, unknown>).blobData
      : undefined,
  ];
  for (const raw of candidates) {
    if (typeof raw === 'string' && /^0x[0-9a-fA-F]+$/.test(raw)) return raw;
    if (raw && typeof raw === 'object') {
      const o2 = raw as Record<string, unknown>;
      if (typeof o2.hex === 'string') return o2.hex;
      if (typeof o2.data === 'string') return o2.data;
    }
  }
  return null;
}

/**
 * Fetch the blob bytes for `versionedHash` from Blobscan. Returns
 * `null` when Blobscan does not have the blob; throws
 * `VersionedHashMismatch` when Blobscan returns bytes that do not
 * hash back to the requested versioned hash.
 */
export async function fetchFromBlobscan(
  opts: BlobscanFetchOptions
): Promise<Uint8Array | null> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (!fetchImpl) {
    throw new Error('no global fetch available; pass fetchImpl explicitly');
  }

  const base = trimSlash(opts.baseUrl);
  const target = ensure0x(opts.versionedHash);

  const res = await fetchImpl(`${base}/blobs/${target}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return null;
  const data = await res.json();

  const hex = extractBlobHex(data);
  if (hex) {
    const bytes = hexToBytes(hex);
    assertVersionedHashMatches(bytes, opts.versionedHash);
    return bytes;
  }

  // v2 path: metadata-only response; follow the first storage URL.
  for (const url of extractStorageUrls(data)) {
    const bin = await fetchImpl(url, {
      headers: { Accept: 'application/octet-stream' },
    });
    if (!bin.ok) continue;
    if (typeof bin.arrayBuffer !== 'function') {
      throw new Error(
        'fetchImpl response missing arrayBuffer(); cannot read v2 blobscan storage URL'
      );
    }
    const buf = await bin.arrayBuffer();
    const bytes = new Uint8Array(buf);
    assertVersionedHashMatches(bytes, opts.versionedHash);
    return bytes;
  }
  return null;
}
