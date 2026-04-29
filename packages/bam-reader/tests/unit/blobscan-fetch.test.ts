import { createBlob, loadTrustedSetup } from 'bam-sdk';
import { beforeAll, describe, expect, it } from 'vitest';

import { fetchFromBlobscan } from '../../src/blob-fetch/blobscan.js';
import type { FetchLike } from '../../src/blob-fetch/beacon.js';
import { VersionedHashMismatch } from '../../src/errors.js';
import { recomputeVersionedHash } from '../../src/blob-fetch/versioned-hash.js';

const BLOBSCAN_URL = 'https://api.sepolia.blobscan.example';

function bytesToHex(bytes: Uint8Array): string {
  let out = '0x';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

interface FixtureBlob {
  blob: Uint8Array;
  versionedHash: `0x${string}`;
}

let fixtureA: FixtureBlob;
let fixtureB: FixtureBlob;

beforeAll(() => {
  loadTrustedSetup();
  const blobA = createBlob(new TextEncoder().encode('blobscan-fixture-A'));
  fixtureA = { blob: blobA, versionedHash: recomputeVersionedHash(blobA) as `0x${string}` };
  const blobB = createBlob(new TextEncoder().encode('blobscan-fixture-B'));
  fixtureB = { blob: blobB, versionedHash: recomputeVersionedHash(blobB) as `0x${string}` };
});

interface MockResponse {
  ok: boolean;
  status: number;
  body: unknown;
  /** When set, the route returns binary bytes via arrayBuffer(). */
  binary?: Uint8Array;
}

function mockFetch(routes: Map<string, MockResponse>): FetchLike {
  return async (url) => {
    const route = routes.get(url);
    if (!route) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return {
      ok: route.ok,
      status: route.status,
      json: async () => route.body,
      arrayBuffer: async () => {
        if (!route.binary) throw new Error('mock route has no binary body');
        // Slice into a fresh ArrayBuffer to avoid leaking the underlying
        // typed-array buffer (which may be a SharedArrayBuffer or larger
        // view than `route.binary`).
        const ab = new ArrayBuffer(route.binary.byteLength);
        new Uint8Array(ab).set(route.binary);
        return ab;
      },
    };
  };
}

function blobsUrl(hash: `0x${string}`): string {
  return `${BLOBSCAN_URL}/blobs/${hash}`;
}

describe('fetchFromBlobscan', () => {
  it('returns blob bytes when Blobscan responds with the correct payload', async () => {
    const fetchImpl = mockFetch(
      new Map<string, MockResponse>([
        [
          blobsUrl(fixtureA.versionedHash),
          { ok: true, status: 200, body: { data: bytesToHex(fixtureA.blob) } },
        ],
      ])
    );
    const got = await fetchFromBlobscan({
      baseUrl: BLOBSCAN_URL,
      versionedHash: fixtureA.versionedHash,
      fetchImpl,
    });
    expect(got).not.toBeNull();
    expect(recomputeVersionedHash(got!)).toBe(fixtureA.versionedHash);
  });

  it('returns null on a 404 response', async () => {
    const fetchImpl = mockFetch(new Map());
    const got = await fetchFromBlobscan({
      baseUrl: BLOBSCAN_URL,
      versionedHash: fixtureA.versionedHash,
      fetchImpl,
    });
    expect(got).toBeNull();
  });

  it('returns null when the response has no recognisable blob field', async () => {
    const fetchImpl = mockFetch(
      new Map<string, MockResponse>([
        [
          blobsUrl(fixtureA.versionedHash),
          { ok: true, status: 200, body: { unrelated: true } },
        ],
      ])
    );
    const got = await fetchFromBlobscan({
      baseUrl: BLOBSCAN_URL,
      versionedHash: fixtureA.versionedHash,
      fetchImpl,
    });
    expect(got).toBeNull();
  });

  it('follows dataStorageReferences[].url and returns the bytes (v2 API)', async () => {
    const storageUrl = 'https://storage.googleapis.com/blobscan-production/x/y/z.bin';
    const fetchImpl = mockFetch(
      new Map<string, MockResponse>([
        [
          blobsUrl(fixtureA.versionedHash),
          {
            ok: true,
            status: 200,
            body: {
              versionedHash: fixtureA.versionedHash,
              dataStorageReferences: [{ storage: 'google', url: storageUrl }],
            },
          },
        ],
        [
          storageUrl,
          { ok: true, status: 200, body: null, binary: fixtureA.blob },
        ],
      ])
    );
    const got = await fetchFromBlobscan({
      baseUrl: BLOBSCAN_URL,
      versionedHash: fixtureA.versionedHash,
      fetchImpl,
    });
    expect(got).not.toBeNull();
    expect(recomputeVersionedHash(got!)).toBe(fixtureA.versionedHash);
  });

  it('rejects v2 storage bytes that do not match the requested versioned hash', async () => {
    const storageUrl = 'https://storage.googleapis.com/blobscan-production/x/y/z.bin';
    const fetchImpl = mockFetch(
      new Map<string, MockResponse>([
        [
          blobsUrl(fixtureA.versionedHash),
          {
            ok: true,
            status: 200,
            body: {
              versionedHash: fixtureA.versionedHash,
              dataStorageReferences: [{ storage: 'google', url: storageUrl }],
            },
          },
        ],
        // Storage URL serves fixtureB's bytes instead of fixtureA's.
        [
          storageUrl,
          { ok: true, status: 200, body: null, binary: fixtureB.blob },
        ],
      ])
    );
    await expect(
      fetchFromBlobscan({
        baseUrl: BLOBSCAN_URL,
        versionedHash: fixtureA.versionedHash,
        fetchImpl,
      })
    ).rejects.toBeInstanceOf(VersionedHashMismatch);
  });

  it('throws VersionedHashMismatch when Blobscan serves wrong bytes for the requested hash', async () => {
    // request fixtureA but server returns fixtureB's bytes
    const fetchImpl = mockFetch(
      new Map<string, MockResponse>([
        [
          blobsUrl(fixtureA.versionedHash),
          { ok: true, status: 200, body: { data: bytesToHex(fixtureB.blob) } },
        ],
      ])
    );
    await expect(
      fetchFromBlobscan({
        baseUrl: BLOBSCAN_URL,
        versionedHash: fixtureA.versionedHash,
        fetchImpl,
      })
    ).rejects.toBeInstanceOf(VersionedHashMismatch);
  });
});
