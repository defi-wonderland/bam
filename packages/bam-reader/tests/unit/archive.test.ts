import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createBlob, loadTrustedSetup } from 'bam-sdk';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createFilesystemBlobArchive } from '../../src/blob-fetch/archive.js';
import { VersionedHashMismatch } from '../../src/errors.js';
import { recomputeVersionedHash } from '../../src/blob-fetch/versioned-hash.js';

let dir: string;
let blob: Uint8Array;
let versionedHash: `0x${string}`;
let otherBlob: Uint8Array;

beforeAll(() => {
  loadTrustedSetup();
  blob = createBlob(new TextEncoder().encode('archive-fixture'));
  versionedHash = recomputeVersionedHash(blob) as `0x${string}`;
  otherBlob = createBlob(new TextEncoder().encode('archive-fixture-other'));
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bam-reader-archive-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('createFilesystemBlobArchive', () => {
  it('returns null on miss', async () => {
    const archive = createFilesystemBlobArchive({ dir });
    expect(await archive.get(versionedHash)).toBeNull();
  });

  it('round-trips put → get with hash verification', async () => {
    const archive = createFilesystemBlobArchive({ dir });
    await archive.put(versionedHash, blob);
    const got = await archive.get(versionedHash);
    expect(got).not.toBeNull();
    expect(recomputeVersionedHash(got!)).toBe(versionedHash);
  });

  it('throws VersionedHashMismatch when the stored bytes do not match the key', async () => {
    const archive = createFilesystemBlobArchive({ dir });
    // Directly plant wrong bytes at the key's path, bypassing put.
    const shard = versionedHash.slice(2, 4);
    const shardDir = path.join(dir, shard);
    await mkdir(shardDir, { recursive: true });
    await writeFile(path.join(shardDir, `${versionedHash}.blob`), otherBlob);

    await expect(archive.get(versionedHash)).rejects.toBeInstanceOf(VersionedHashMismatch);
  });

  it('rejects malformed versioned hashes', async () => {
    const archive = createFilesystemBlobArchive({ dir });
    await expect(archive.get('0xnope' as `0x${string}`)).rejects.toThrow(/invalid versioned hash/);
    await expect(archive.put('not-a-hash' as `0x${string}`, blob)).rejects.toThrow(
      /invalid versioned hash/
    );
  });

  it('shards files by the first byte of the hash', async () => {
    const archive = createFilesystemBlobArchive({ dir });
    await archive.put(versionedHash, blob);
    const entries = await readdir(dir);
    expect(entries).toContain(versionedHash.slice(2, 4));
    const shardEntries = await readdir(path.join(dir, versionedHash.slice(2, 4)));
    expect(shardEntries).toContain(`${versionedHash}.blob`);
  });

  it('does not leave temp files behind after a successful write', async () => {
    const archive = createFilesystemBlobArchive({ dir });
    await archive.put(versionedHash, blob);
    const shardEntries = await readdir(path.join(dir, versionedHash.slice(2, 4)));
    const tmpFiles = shardEntries.filter((e) => e.includes('.tmp.'));
    expect(tmpFiles).toEqual([]);
  });

  it('overwrites an existing entry idempotently', async () => {
    const archive = createFilesystemBlobArchive({ dir });
    await archive.put(versionedHash, blob);
    await archive.put(versionedHash, blob);
    const got = await archive.get(versionedHash);
    expect(got).not.toBeNull();
    expect(recomputeVersionedHash(got!)).toBe(versionedHash);
  });
});
