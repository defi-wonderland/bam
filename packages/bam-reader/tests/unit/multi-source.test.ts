import { commitToBlob, createBlob, loadTrustedSetup } from 'bam-sdk';
import type { Bytes32 } from 'bam-sdk';
import { beforeAll, describe, expect, it } from 'vitest';

import type { BlobArchive } from '../../src/blob-fetch/archive.js';
import type { FetchLike } from '../../src/blob-fetch/beacon.js';
import {
  fetchBlob,
  type BlobSourceEvent,
} from '../../src/blob-fetch/multi-source.js';
import { recomputeVersionedHash } from '../../src/blob-fetch/versioned-hash.js';
import { VersionedHashMismatch } from '../../src/errors.js';

const PARENT_ROOT = ('0x' + 'cd'.repeat(32)) as `0x${string}`;
const BEACON_URL = 'https://beacon.example.test';
const BLOBSCAN_URL = 'https://api.blobscan.example.test';
const SLOT = '17171717';

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
  const blobA = createBlob(new TextEncoder().encode('multi-source-A'));
  const cmtA = commitToBlob(blobA);
  fixtureA = {
    blob: blobA,
    versionedHash: recomputeVersionedHash(blobA) as `0x${string}`,
    commitmentHex: bytesToHex(cmtA.commitment) as `0x${string}`,
  };
  const blobB = createBlob(new TextEncoder().encode('multi-source-B'));
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

function beaconHeadersUrl(): string {
  return `${BEACON_URL}/eth/v1/beacon/headers?parent_root=${encodeURIComponent(PARENT_ROOT)}`;
}

function beaconSidecarsUrl(slot: string): string {
  return `${BEACON_URL}/eth/v1/beacon/blob_sidecars/${slot}`;
}

function blobscanUrl(hash: `0x${string}`): string {
  return `${BLOBSCAN_URL}/blobs/${hash}`;
}

function beaconRoutes(commitment: `0x${string}`, blob: Uint8Array): Array<[string, MockResponse]> {
  return [
    [
      beaconHeadersUrl(),
      { ok: true, status: 200, body: { data: [{ header: { message: { slot: SLOT } } }] } },
    ],
    [
      beaconSidecarsUrl(SLOT),
      {
        ok: true,
        status: 200,
        body: { data: [{ kzg_commitment: commitment, blob: bytesToHex(blob) }] },
      },
    ],
  ];
}

describe('fetchBlob', () => {
  it('returns the blob bytes from the primary beacon source on success', async () => {
    const fetchImpl = mockFetch(
      new Map<string, MockResponse>(beaconRoutes(fixtureA.commitmentHex, fixtureA.blob))
    );
    const events: BlobSourceEvent[] = [];
    const got = await fetchBlob({
      versionedHash: fixtureA.versionedHash,
      parentBeaconBlockRoot: PARENT_ROOT,
      sources: { beaconUrl: BEACON_URL, blobscanUrl: BLOBSCAN_URL },
      fetchImpl,
      logger: (e) => events.push(e),
    });
    expect(got).not.toBeNull();
    expect(recomputeVersionedHash(got!)).toBe(fixtureA.versionedHash);
    expect(events).toEqual([]);
  });

  it('falls back to Blobscan when the beacon source returns null', async () => {
    const fetchImpl = mockFetch(
      new Map<string, MockResponse>([
        // Beacon returns headers but no matching sidecar.
        ...beaconRoutes(fixtureB.commitmentHex, fixtureB.blob),
        [
          blobscanUrl(fixtureA.versionedHash),
          { ok: true, status: 200, body: { data: bytesToHex(fixtureA.blob) } },
        ],
      ])
    );
    const got = await fetchBlob({
      versionedHash: fixtureA.versionedHash,
      parentBeaconBlockRoot: PARENT_ROOT,
      sources: { beaconUrl: BEACON_URL, blobscanUrl: BLOBSCAN_URL },
      fetchImpl,
    });
    expect(got).not.toBeNull();
    expect(recomputeVersionedHash(got!)).toBe(fixtureA.versionedHash);
  });

  it('falls back to Blobscan when the beacon source returns wrong-hash bytes (lied)', async () => {
    const fetchImpl = mockFetch(
      new Map<string, MockResponse>([
        // Beacon names fixtureA's commitment but ships fixtureB's blob.
        ...beaconRoutes(fixtureA.commitmentHex, fixtureB.blob),
        [
          blobscanUrl(fixtureA.versionedHash),
          { ok: true, status: 200, body: { data: bytesToHex(fixtureA.blob) } },
        ],
      ])
    );
    const events: BlobSourceEvent[] = [];
    const got = await fetchBlob({
      versionedHash: fixtureA.versionedHash,
      parentBeaconBlockRoot: PARENT_ROOT,
      sources: { beaconUrl: BEACON_URL, blobscanUrl: BLOBSCAN_URL },
      fetchImpl,
      logger: (e) => events.push(e),
    });
    expect(got).not.toBeNull();
    expect(recomputeVersionedHash(got!)).toBe(fixtureA.versionedHash);
    expect(events).toEqual([
      { kind: 'source_lied', source: 'beacon', versionedHash: fixtureA.versionedHash },
    ]);
  });

  it('returns null when both sources return null', async () => {
    const fetchImpl = mockFetch(new Map());
    const events: BlobSourceEvent[] = [];
    const got = await fetchBlob({
      versionedHash: fixtureA.versionedHash,
      parentBeaconBlockRoot: PARENT_ROOT,
      sources: { beaconUrl: BEACON_URL, blobscanUrl: BLOBSCAN_URL },
      fetchImpl,
      logger: (e) => events.push(e),
    });
    expect(got).toBeNull();
    // No source lied — both simply returned 404. No "all lied" event.
    expect(events).toEqual([]);
  });

  it('emits "all_sources_lied" when every configured source returned wrong-hash bytes', async () => {
    const fetchImpl = mockFetch(
      new Map<string, MockResponse>([
        ...beaconRoutes(fixtureA.commitmentHex, fixtureB.blob),
        [
          blobscanUrl(fixtureA.versionedHash),
          { ok: true, status: 200, body: { data: bytesToHex(fixtureB.blob) } },
        ],
      ])
    );
    const events: BlobSourceEvent[] = [];
    const got = await fetchBlob({
      versionedHash: fixtureA.versionedHash,
      parentBeaconBlockRoot: PARENT_ROOT,
      sources: { beaconUrl: BEACON_URL, blobscanUrl: BLOBSCAN_URL },
      fetchImpl,
      logger: (e) => events.push(e),
    });
    expect(got).toBeNull();
    expect(events).toContainEqual({
      kind: 'source_lied',
      source: 'beacon',
      versionedHash: fixtureA.versionedHash,
    });
    expect(events).toContainEqual({
      kind: 'source_lied',
      source: 'blobscan',
      versionedHash: fixtureA.versionedHash,
    });
    expect(events).toContainEqual({
      kind: 'all_sources_lied',
      versionedHash: fixtureA.versionedHash,
    });
  });

  it('returns null when no sources are configured', async () => {
    const fetchImpl = mockFetch(new Map());
    const got = await fetchBlob({
      versionedHash: fixtureA.versionedHash,
      parentBeaconBlockRoot: PARENT_ROOT,
      sources: {},
      fetchImpl,
    });
    expect(got).toBeNull();
  });

  // ────────────────────────── archive integration ──────────────────────────

  interface FakeArchive extends BlobArchive {
    readonly store: Map<string, Uint8Array>;
    readonly getCalls: Bytes32[];
    readonly putCalls: Bytes32[];
  }

  function fakeArchive(opts?: {
    seed?: Array<[Bytes32, Uint8Array]>;
    getError?: () => Error;
    putError?: () => Error;
  }): FakeArchive {
    const store = new Map<string, Uint8Array>(
      (opts?.seed ?? []).map(([k, v]) => [k.toLowerCase(), v])
    );
    const getCalls: Bytes32[] = [];
    const putCalls: Bytes32[] = [];
    return {
      store,
      getCalls,
      putCalls,
      async get(vh) {
        getCalls.push(vh);
        if (opts?.getError) throw opts.getError();
        const hit = store.get(vh.toLowerCase());
        return hit ?? null;
      },
      async put(vh, bytes) {
        putCalls.push(vh);
        if (opts?.putError) throw opts.putError();
        store.set(vh.toLowerCase(), bytes);
      },
    };
  }

  it('serves from archive on hit and skips the network entirely', async () => {
    const archive = fakeArchive({ seed: [[fixtureA.versionedHash, fixtureA.blob]] });
    let networkCalls = 0;
    const fetchImpl: FetchLike = async () => {
      networkCalls++;
      return { ok: false, status: 500, json: async () => ({}) };
    };
    const events: BlobSourceEvent[] = [];
    const got = await fetchBlob({
      versionedHash: fixtureA.versionedHash,
      parentBeaconBlockRoot: PARENT_ROOT,
      sources: { beaconUrl: BEACON_URL, blobscanUrl: BLOBSCAN_URL },
      archive,
      fetchImpl,
      logger: (e) => events.push(e),
    });
    expect(got).not.toBeNull();
    expect(recomputeVersionedHash(got!)).toBe(fixtureA.versionedHash);
    expect(networkCalls).toBe(0);
    expect(events).toContainEqual({
      kind: 'archive_hit',
      versionedHash: fixtureA.versionedHash,
    });
    expect(archive.putCalls).toEqual([]);
  });

  it('falls through to network on archive miss and writes back', async () => {
    const archive = fakeArchive();
    const fetchImpl = mockFetch(
      new Map<string, MockResponse>(beaconRoutes(fixtureA.commitmentHex, fixtureA.blob))
    );
    const got = await fetchBlob({
      versionedHash: fixtureA.versionedHash,
      parentBeaconBlockRoot: PARENT_ROOT,
      sources: { beaconUrl: BEACON_URL, blobscanUrl: BLOBSCAN_URL },
      archive,
      fetchImpl,
    });
    expect(got).not.toBeNull();
    expect(recomputeVersionedHash(got!)).toBe(fixtureA.versionedHash);
    expect(archive.putCalls).toEqual([fixtureA.versionedHash]);
    expect(archive.store.get(fixtureA.versionedHash.toLowerCase())).toBeDefined();
  });

  it('treats a lying archive like a lying upstream and falls through', async () => {
    const archive = fakeArchive();
    const events: BlobSourceEvent[] = [];
    // Make archive.get() throw VersionedHashMismatch — mirrors what the
    // filesystem archive does on a tampered file.
    archive.get = async (vh) => {
      throw new VersionedHashMismatch(`mismatch on ${vh}`);
    };
    const fetchImpl = mockFetch(
      new Map<string, MockResponse>(beaconRoutes(fixtureA.commitmentHex, fixtureA.blob))
    );
    const got = await fetchBlob({
      versionedHash: fixtureA.versionedHash,
      parentBeaconBlockRoot: PARENT_ROOT,
      sources: { beaconUrl: BEACON_URL, blobscanUrl: BLOBSCAN_URL },
      archive,
      fetchImpl,
      logger: (e) => events.push(e),
    });
    expect(got).not.toBeNull();
    expect(recomputeVersionedHash(got!)).toBe(fixtureA.versionedHash);
    expect(events).toContainEqual({
      kind: 'source_lied',
      source: 'archive',
      versionedHash: fixtureA.versionedHash,
    });
  });

  it('swallows archive read errors and logs them', async () => {
    const archive = fakeArchive({ getError: () => new Error('EIO: disk on fire') });
    const events: BlobSourceEvent[] = [];
    const fetchImpl = mockFetch(
      new Map<string, MockResponse>(beaconRoutes(fixtureA.commitmentHex, fixtureA.blob))
    );
    const got = await fetchBlob({
      versionedHash: fixtureA.versionedHash,
      parentBeaconBlockRoot: PARENT_ROOT,
      sources: { beaconUrl: BEACON_URL, blobscanUrl: BLOBSCAN_URL },
      archive,
      fetchImpl,
      logger: (e) => events.push(e),
    });
    expect(got).not.toBeNull();
    expect(events).toContainEqual({
      kind: 'archive_read_failed',
      versionedHash: fixtureA.versionedHash,
      error: 'EIO: disk on fire',
    });
  });

  it('returns network bytes even when archive write-back fails', async () => {
    const archive = fakeArchive({ putError: () => new Error('ENOSPC') });
    const events: BlobSourceEvent[] = [];
    const fetchImpl = mockFetch(
      new Map<string, MockResponse>(beaconRoutes(fixtureA.commitmentHex, fixtureA.blob))
    );
    const got = await fetchBlob({
      versionedHash: fixtureA.versionedHash,
      parentBeaconBlockRoot: PARENT_ROOT,
      sources: { beaconUrl: BEACON_URL, blobscanUrl: BLOBSCAN_URL },
      archive,
      fetchImpl,
      logger: (e) => events.push(e),
    });
    expect(got).not.toBeNull();
    expect(events).toContainEqual({
      kind: 'archive_write_failed',
      versionedHash: fixtureA.versionedHash,
      error: 'ENOSPC',
    });
  });
});
