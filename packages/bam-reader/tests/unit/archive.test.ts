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

import {
  createFilesystemBlobArchive,
  verifyingArchive,
  type BlobArchive,
} from '../../src/blob-fetch/archive.js';
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

  it('does not leak the temp file when the final rename fails', async () => {
    // Build a working FS archive, then stub the inner rename via a
    // wrapper that simulates a publish failure after a successful write.
    // The check is: after the put rejects, no `.tmp.*` strays remain
    // in the shard dir (cubic PR-45).
    const archive = await createFilesystemBlobArchive({ dir });
    const shardDir = path.join(dir, versionedHash.slice(2, 4));
    await mkdir(shardDir, { recursive: true });
    // Pre-create the destination as a directory so `rename` from a
    // file to that path is forced to fail with EISDIR — exercises the
    // "wrote OK, rename failed" path without monkey-patching node:fs.
    await mkdir(path.join(shardDir, `${versionedHash}.blob`), {
      recursive: true,
    });
    await expect(archive.put(versionedHash, blob)).rejects.toBeDefined();
    const entries = await readdir(shardDir);
    expect(entries.filter((e) => e.startsWith(`${versionedHash}.blob.tmp.`))).toEqual([]);
  });
});

describe('verifyingArchive', () => {
  function passthrough(seed?: Map<string, Uint8Array>): BlobArchive {
    const store = seed ?? new Map<string, Uint8Array>();
    return {
      async get(vh) {
        return store.get(vh.toLowerCase()) ?? null;
      },
      async put(vh, bytes) {
        store.set(vh.toLowerCase(), bytes);
      },
    };
  }

  it('passes correctly-hashed bytes through on get', async () => {
    const inner = passthrough(new Map([[versionedHash.toLowerCase(), blob]]));
    const wrapped = verifyingArchive(inner);
    const got = await wrapped.get(versionedHash);
    expect(got).not.toBeNull();
    expect(recomputeVersionedHash(got!)).toBe(versionedHash);
  });

  it('returns null on miss without throwing', async () => {
    const wrapped = verifyingArchive(passthrough());
    expect(await wrapped.get(versionedHash)).toBeNull();
  });

  it('throws VersionedHashMismatch when the inner backend returns wrong-hash bytes', async () => {
    // A custom backend forgets to verify and returns wrong bytes; the
    // wrapper must catch it so the orchestrator sees `source_lied`.
    const inner = passthrough(new Map([[versionedHash.toLowerCase(), otherBlob]]));
    const wrapped = verifyingArchive(inner);
    await expect(wrapped.get(versionedHash)).rejects.toBeInstanceOf(VersionedHashMismatch);
  });

  it('rejects put with wrong-length bytes before they reach the inner backend', async () => {
    const inner = passthrough();
    const wrapped = verifyingArchive(inner);
    await expect(
      wrapped.put(versionedHash, new Uint8Array(10))
    ).rejects.toBeInstanceOf(VersionedHashMismatch);
    // Inner store must remain untouched.
    expect(await inner.get(versionedHash)).toBeNull();
  });

  it('forwards close() to the inner backend when present', async () => {
    let closed = false;
    const inner: BlobArchive = {
      async get() {
        return null;
      },
      async put() {},
      async close() {
        closed = true;
      },
    };
    const wrapped = verifyingArchive(inner);
    await wrapped.close!();
    expect(closed).toBe(true);
  });
});
