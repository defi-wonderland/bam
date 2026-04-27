import { commitToBlob, createBlob, loadTrustedSetup } from 'bam-sdk';
import { beforeAll, describe, expect, it } from 'vitest';

import { fetchFromBeaconApi, type FetchLike } from '../../src/blob-fetch/beacon.js';
import { VersionedHashMismatch } from '../../src/errors.js';
import { recomputeVersionedHash } from '../../src/blob-fetch/versioned-hash.js';

const PARENT_ROOT = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
const BEACON_URL = 'https://beacon.example.test';
const SLOT = '99812';

function bytesToHex(bytes: Uint8Array): string {
  let out = '0x';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

interface FixtureBlob {
  blob: Uint8Array;
  versionedHash: `0x${string}`;
  commitmentHex: `0x${string}`;
}

let fixtureA: FixtureBlob;
let fixtureB: FixtureBlob;

beforeAll(() => {
  loadTrustedSetup();
  const blobA = createBlob(new TextEncoder().encode('beacon-fixture-A'));
  const cmtA = commitToBlob(blobA);
  fixtureA = {
    blob: blobA,
    versionedHash: recomputeVersionedHash(blobA) as `0x${string}`,
    commitmentHex: bytesToHex(cmtA.commitment) as `0x${string}`,
  };
  const blobB = createBlob(new TextEncoder().encode('beacon-fixture-B'));
  const cmtB = commitToBlob(blobB);
  fixtureB = {
    blob: blobB,
    versionedHash: recomputeVersionedHash(blobB) as `0x${string}`,
    commitmentHex: bytesToHex(cmtB.commitment) as `0x${string}`,
  };
});

interface MockResponse {
  ok: boolean;
  status: number;
  body: unknown;
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
    };
  };
}

function headersUrl(): string {
  return `${BEACON_URL}/eth/v1/beacon/headers?parent_root=${encodeURIComponent(PARENT_ROOT)}`;
}

function sidecarsUrl(slot: string): string {
  return `${BEACON_URL}/eth/v1/beacon/blob_sidecars/${slot}`;
}

describe('fetchFromBeaconApi', () => {
  it('returns the blob bytes on a happy path with a matching commitment', async () => {
    const fetchImpl = mockFetch(
      new Map<string, MockResponse>([
        [
          headersUrl(),
          { ok: true, status: 200, body: { data: [{ header: { message: { slot: SLOT } } }] } },
        ],
        [
          sidecarsUrl(SLOT),
          {
            ok: true,
            status: 200,
            body: {
              data: [
                {
                  kzg_commitment: fixtureA.commitmentHex,
                  blob: bytesToHex(fixtureA.blob),
                },
              ],
            },
          },
        ],
      ])
    );

    const got = await fetchFromBeaconApi({
      beaconUrl: BEACON_URL,
      parentBeaconBlockRoot: PARENT_ROOT,
      versionedHash: fixtureA.versionedHash,
      fetchImpl,
    });
    expect(got).not.toBeNull();
    expect(recomputeVersionedHash(got!)).toBe(fixtureA.versionedHash);
  });

  it('returns null when the headers endpoint returns 404', async () => {
    const fetchImpl = mockFetch(new Map());
    const got = await fetchFromBeaconApi({
      beaconUrl: BEACON_URL,
      parentBeaconBlockRoot: PARENT_ROOT,
      versionedHash: fixtureA.versionedHash,
      fetchImpl,
    });
    expect(got).toBeNull();
  });

  it('returns null when the sidecars endpoint returns 404', async () => {
    const fetchImpl = mockFetch(
      new Map<string, MockResponse>([
        [
          headersUrl(),
          { ok: true, status: 200, body: { data: [{ header: { message: { slot: SLOT } } }] } },
        ],
      ])
    );
    const got = await fetchFromBeaconApi({
      beaconUrl: BEACON_URL,
      parentBeaconBlockRoot: PARENT_ROOT,
      versionedHash: fixtureA.versionedHash,
      fetchImpl,
    });
    expect(got).toBeNull();
  });

  it('returns null when no sidecar commits to the requested versioned hash', async () => {
    const fetchImpl = mockFetch(
      new Map<string, MockResponse>([
        [
          headersUrl(),
          { ok: true, status: 200, body: { data: [{ header: { message: { slot: SLOT } } }] } },
        ],
        [
          sidecarsUrl(SLOT),
          {
            ok: true,
            status: 200,
            body: {
              data: [
                {
                  kzg_commitment: fixtureB.commitmentHex,
                  blob: bytesToHex(fixtureB.blob),
                },
              ],
            },
          },
        ],
      ])
    );
    const got = await fetchFromBeaconApi({
      beaconUrl: BEACON_URL,
      parentBeaconBlockRoot: PARENT_ROOT,
      versionedHash: fixtureA.versionedHash,
      fetchImpl,
    });
    expect(got).toBeNull();
  });

  it('throws VersionedHashMismatch if a matching-commitment sidecar serves wrong blob bytes', async () => {
    // Sidecar names fixtureA's commitment but ships fixtureB's blob.
    const fetchImpl = mockFetch(
      new Map<string, MockResponse>([
        [
          headersUrl(),
          { ok: true, status: 200, body: { data: [{ header: { message: { slot: SLOT } } }] } },
        ],
        [
          sidecarsUrl(SLOT),
          {
            ok: true,
            status: 200,
            body: {
              data: [
                {
                  kzg_commitment: fixtureA.commitmentHex,
                  blob: bytesToHex(fixtureB.blob),
                },
              ],
            },
          },
        ],
      ])
    );
    await expect(
      fetchFromBeaconApi({
        beaconUrl: BEACON_URL,
        parentBeaconBlockRoot: PARENT_ROOT,
        versionedHash: fixtureA.versionedHash,
        fetchImpl,
      })
    ).rejects.toBeInstanceOf(VersionedHashMismatch);
  });
});
