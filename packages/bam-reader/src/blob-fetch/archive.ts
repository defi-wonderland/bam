/**
 * Local blob archive — backend-agnostic read/write contract.
 *
 * Stores blob bytes keyed by `versionedHash` so the Reader can replay
 * batches without re-fetching from beacon/Blobscan. The interface is
 * intentionally minimal so the substrate can swap later (filesystem
 * today, S3 or DB-resident bytea tomorrow).
 *
 * Trust model mirrors the off-chain sources: every read is independently
 * re-hashed against the requested versioned hash. A corrupted archive
 * file surfaces as `VersionedHashMismatch` and is treated exactly like
 * a lying upstream — never as authoritative content.
 */
import { randomUUID } from 'node:crypto';
import { open, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import type { Bytes32 } from 'bam-sdk';

import { assertVersionedHashMatches } from './versioned-hash.js';

export interface BlobArchive {
  /** Return blob bytes for `versionedHash`, or `null` when absent. */
  get(versionedHash: Bytes32): Promise<Uint8Array | null>;
  /** Idempotent write. May be a no-op for read-only backends. */
  put(versionedHash: Bytes32, bytes: Uint8Array): Promise<void>;
  /** Release any held resources. Optional. */
  close?(): Promise<void>;
}

export interface FilesystemBlobArchiveOptions {
  /** Root directory for the archive. Created on first write if absent. */
  dir: string;
}

const VH_RE = /^0x[0-9a-f]{64}$/;

function normalizeVersionedHash(vh: Bytes32): string {
  const lower = vh.toLowerCase();
  if (!VH_RE.test(lower)) {
    throw new Error(`invalid versioned hash for archive: ${vh}`);
  }
  return lower;
}

function pathsFor(root: string, vh: string): { shardDir: string; file: string } {
  // One-level shard by the first byte of the hash to keep any single
  // directory under a manageable fanout.
  const shard = vh.slice(2, 4);
  const shardDir = path.join(root, shard);
  return { shardDir, file: path.join(shardDir, `${vh}.blob`) };
}

/**
 * Filesystem-backed `BlobArchive`. Layout: `<dir>/<aa>/0xaa….blob`.
 *
 * Writes use temp-file + rename for atomicity-of-name. fsync is *not*
 * called: durability matters less than correctness here, and the
 * content-addressed naming means a torn file is detected on next read
 * (via `assertVersionedHashMatches`) and treated as a cache miss —
 * the network refetch + rewrite recovers without operator action.
 */
export function createFilesystemBlobArchive(
  opts: FilesystemBlobArchiveOptions
): BlobArchive {
  const root = opts.dir;
  return {
    async get(versionedHash) {
      const vh = normalizeVersionedHash(versionedHash);
      const { file } = pathsFor(root, vh);
      let buf: Buffer;
      try {
        buf = await readFile(file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
      const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      assertVersionedHashMatches(bytes, versionedHash);
      return bytes;
    },

    async put(versionedHash, bytes) {
      const vh = normalizeVersionedHash(versionedHash);
      const { shardDir, file } = pathsFor(root, vh);
      await mkdir(shardDir, { recursive: true });
      const tmp = `${file}.tmp.${randomUUID()}`;
      const handle = await open(tmp, 'w');
      let wrote = false;
      try {
        await handle.writeFile(bytes);
        wrote = true;
      } finally {
        await handle.close();
        if (!wrote) {
          await unlink(tmp).catch(() => {});
        }
      }
      await rename(tmp, file);
    },
  };
}
