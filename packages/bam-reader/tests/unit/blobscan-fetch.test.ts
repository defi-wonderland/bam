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
  /**
   * Override response headers. Defaults to `{ content-length: <binary.byteLength> }`
   * when `binary` is set, otherwise an empty header bag. Set to `null` to
   * simulate a response with no headers exposed at all.
   */
  headers?: Record<string, string> | null;
  /** When true, the mock throws synchronously to simulate a redirect-error fetch. */
  throwOnFetch?: Error;
}

interface FetchCall {
  url: string;
  init?: { headers?: Record<string, string>; redirect?: 'follow' | 'manual' | 'error' };
}

function mockFetch(
  routes: Map<string, MockResponse>,
  calls: FetchCall[] = []
): FetchLike {
  return async (url, init) => {
    calls.push({ url, init });
    const route = routes.get(url);
    if (!route) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (route.throwOnFetch) throw route.throwOnFetch;
    const headerEntries =
      route.headers === null
        ? null
        : route.headers ??
          (route.binary ? { 'content-length': String(route.binary.byteLength) } : {});
    const headers =
      headerEntries === null
        ? undefined
        : {
            get(name: string): string | null {
              return headerEntries[name.toLowerCase()] ?? null;
            },
          };
    return {
      ok: route.ok,
      status: route.status,
      headers,
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

  it.each([
    ['IPv4 literal',          'http://169.254.169.254/latest/meta-data/'],
    ['IPv4 RFC1918',          'http://10.0.0.5/blob.bin'],
    ['IPv6 literal',          'http://[::1]/blob.bin'],
    ['localhost',             'http://localhost:5432/blob.bin'],
    ['localhost FQDN dot',    'http://localhost./blob.bin'],
    ['.internal suffix',      'https://blobs.svc.internal/x/y/z.bin'],
    ['.internal FQDN dot',    'https://blobs.svc.internal./x/y/z.bin'],
    ['.local suffix',         'https://nas.local/blob.bin'],
  ])('refuses to fetch v2 storage URL with %s', async (_label, badUrl) => {
    const fetchImpl = mockFetch(
      new Map<string, MockResponse>([
        [
          blobsUrl(fixtureA.versionedHash),
          {
            ok: true,
            status: 200,
            body: {
              versionedHash: fixtureA.versionedHash,
              dataStorageReferences: [{ storage: 'google', url: badUrl }],
            },
          },
        ],
      ])
    );
    await expect(
      fetchFromBlobscan({
        baseUrl: BLOBSCAN_URL,
        versionedHash: fixtureA.versionedHash,
        fetchImpl,
      })
    ).rejects.toThrow(/refusing/);
  });

  it("passes redirect: 'error' on the v2 storage URL fetch (redirects disabled)", async () => {
    const storageUrl = 'https://storage.googleapis.com/blobscan-production/x/y/z.bin';
    const calls: FetchCall[] = [];
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
      ]),
      calls
    );
    await fetchFromBlobscan({
      baseUrl: BLOBSCAN_URL,
      versionedHash: fixtureA.versionedHash,
      fetchImpl,
    });
    const storageCall = calls.find((c) => c.url === storageUrl);
    expect(storageCall?.init?.redirect).toBe('error');
  });

  it('rejects v2 storage response missing Content-Length', async () => {
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
          {
            ok: true,
            status: 200,
            body: null,
            binary: fixtureA.blob,
            headers: {}, // no content-length
          },
        ],
      ])
    );
    await expect(
      fetchFromBlobscan({
        baseUrl: BLOBSCAN_URL,
        versionedHash: fixtureA.versionedHash,
        fetchImpl,
      })
    ).rejects.toThrow(/Content-Length/);
  });

  it('rejects v2 storage response with implausibly large Content-Length', async () => {
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
          {
            ok: true,
            status: 200,
            body: null,
            binary: fixtureA.blob,
            headers: { 'content-length': String(10 * 1024 * 1024) }, // 10 MiB
          },
        ],
      ])
    );
    await expect(
      fetchFromBlobscan({
        baseUrl: BLOBSCAN_URL,
        versionedHash: fixtureA.versionedHash,
        fetchImpl,
      })
    ).rejects.toThrow(/implausible Content-Length/);
  });

  it('surfaces a clear error when the storage URL fetch throws (redirect rejected by impl)', async () => {
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
          {
            ok: false,
            status: 0,
            body: null,
            throwOnFetch: new TypeError('redirect mode is set to error'),
          },
        ],
      ])
    );
    await expect(
      fetchFromBlobscan({
        baseUrl: BLOBSCAN_URL,
        versionedHash: fixtureA.versionedHash,
        fetchImpl,
      })
    ).rejects.toThrow(/redirects disabled/);
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
