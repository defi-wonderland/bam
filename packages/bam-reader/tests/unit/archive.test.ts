import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createBlob, loadTrustedSetup } from 'bam-sdk';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createFilesystemBlobArchive } from '../../src/blob-fetch/archive.js';
import { VersionedHashMismatch } from '../../src/errors.js';
import {
  FULL_BLOB_BYTE_LENGTH,
  recomputeVersionedHash,
} from '../../src/blob-fetch/versioned-hash.js';

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
  it('creates the archive dir at construction if absent', async () => {
    const nested = path.join(dir, 'sub', 'archive');
    await createFilesystemBlobArchive({ dir: nested });
    await expect(access(nested)).resolves.toBeUndefined();
  });

  it('returns null on miss', async () => {
    const archive = await createFilesystemBlobArchive({ dir });
    expect(await archive.get(versionedHash)).toBeNull();
  });

  it('round-trips put → get with hash verification', async () => {
    const archive = await createFilesystemBlobArchive({ dir });
    await archive.put(versionedHash, blob);
    const got = await archive.get(versionedHash);
    expect(got).not.toBeNull();
    expect(recomputeVersionedHash(got!)).toBe(versionedHash);
  });

  it('throws VersionedHashMismatch when the stored bytes do not match the key', async () => {
    const archive = await createFilesystemBlobArchive({ dir });
    const shard = versionedHash.slice(2, 4);
    const shardDir = path.join(dir, shard);
    await mkdir(shardDir, { recursive: true });
    await writeFile(path.join(shardDir, `${versionedHash}.blob`), otherBlob);

    await expect(archive.get(versionedHash)).rejects.toBeInstanceOf(VersionedHashMismatch);
  });

  it('throws VersionedHashMismatch on a wrong-size entry without buffering it', async () => {
    const archive = await createFilesystemBlobArchive({ dir });
    const shard = versionedHash.slice(2, 4);
    const shardDir = path.join(dir, shard);
    await mkdir(shardDir, { recursive: true });
    // Plant a tiny file (1 byte) — bytes-on-disk are wrong-shape.
    await writeFile(path.join(shardDir, `${versionedHash}.blob`), new Uint8Array(1));
    await expect(archive.get(versionedHash)).rejects.toBeInstanceOf(VersionedHashMismatch);
    // And an oversized file — must not be read into memory.
    await writeFile(
      path.join(shardDir, `${versionedHash}.blob`),
      new Uint8Array(FULL_BLOB_BYTE_LENGTH + 1024)
    );
    await expect(archive.get(versionedHash)).rejects.toBeInstanceOf(VersionedHashMismatch);
  });

  it('rejects malformed versioned hashes', async () => {
    const archive = await createFilesystemBlobArchive({ dir });
    await expect(archive.get('0xnope' as `0x${string}`)).rejects.toThrow(/invalid versioned hash/);
    await expect(archive.put('not-a-hash' as `0x${string}`, blob)).rejects.toThrow(
      /invalid versioned hash/
    );
  });

  it('shards files by the first byte of the hash', async () => {
    const archive = await createFilesystemBlobArchive({ dir });
    await archive.put(versionedHash, blob);
    const entries = await readdir(dir);
    expect(entries).toContain(versionedHash.slice(2, 4));
    const shardEntries = await readdir(path.join(dir, versionedHash.slice(2, 4)));
    expect(shardEntries).toContain(`${versionedHash}.blob`);
  });

  it('does not leave temp files behind after a successful write', async () => {
    const archive = await createFilesystemBlobArchive({ dir });
    await archive.put(versionedHash, blob);
    const shardEntries = await readdir(path.join(dir, versionedHash.slice(2, 4)));
    const tmpFiles = shardEntries.filter((e) => e.includes('.tmp.'));
    expect(tmpFiles).toEqual([]);
  });

  it('overwrites an existing entry idempotently', async () => {
    const archive = await createFilesystemBlobArchive({ dir });
    await archive.put(versionedHash, blob);
    await archive.put(versionedHash, blob);
    const got = await archive.get(versionedHash);
    expect(got).not.toBeNull();
    expect(recomputeVersionedHash(got!)).toBe(versionedHash);
  });

  it('handles concurrent puts for the same hash without corruption', async () => {
    const archive = await createFilesystemBlobArchive({ dir });
    await Promise.all([
      archive.put(versionedHash, blob),
      archive.put(versionedHash, blob),
      archive.put(versionedHash, blob),
    ]);
    const got = await archive.get(versionedHash);
    expect(got).not.toBeNull();
    expect(recomputeVersionedHash(got!)).toBe(versionedHash);
    // No straggling temp files.
    const shardEntries = await readdir(path.join(dir, versionedHash.slice(2, 4)));
    expect(shardEntries.filter((e) => e.includes('.tmp.'))).toEqual([]);
  });
});
