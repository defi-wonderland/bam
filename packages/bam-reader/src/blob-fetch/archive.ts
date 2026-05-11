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
import { open, mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import type { Bytes32 } from 'bam-sdk';

import { VersionedHashMismatch } from '../errors.js';
import {
  assertVersionedHashMatches,
  FULL_BLOB_BYTE_LENGTH,
} from './versioned-hash.js';

export interface BlobArchive {
  /** Return blob bytes for `versionedHash`, or `null` when absent. */
  get(versionedHash: Bytes32): Promise<Uint8Array | null>;
  /** Idempotent write. May be a no-op for read-only backends. */
  put(versionedHash: Bytes32, bytes: Uint8Array): Promise<void>;
  /** Release any held resources. Optional. */
  close?(): Promise<void>;
}

export interface FilesystemBlobArchiveOptions {
  /** Root directory for the archive. Created at construction if absent. */
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
 * Wrap an arbitrary `BlobArchive` with hash-verification on every
 * I/O. `get()` re-hashes the bytes against the requested versioned
 * hash and throws `VersionedHashMismatch` on disagreement; `put()`
 * length-checks the input (a wrong-length blob can never round-trip
 * through the versioned-hash check, so refusing it up front avoids
 * persisting garbage). Use this at the factory boundary so the
 * orchestrator and HTTP path get the trust guarantee for free —
 * a custom backend (S3, DB, …) inherits enforcement without having
 * to remember to verify.
 */
export function verifyingArchive(inner: BlobArchive): BlobArchive {
  return {
    async get(versionedHash) {
      const bytes = await inner.get(versionedHash);
      if (bytes === null) return null;
      assertVersionedHashMatches(bytes, versionedHash);
      return bytes;
    },
    async put(versionedHash, bytes) {
      if (bytes.byteLength !== FULL_BLOB_BYTE_LENGTH) {
        throw new VersionedHashMismatch(
          `archive put: bytes length ${bytes.byteLength} != ${FULL_BLOB_BYTE_LENGTH}`
        );
      }
      await inner.put(versionedHash, bytes);
    },
    close: inner.close ? () => inner.close!() : undefined,
  };
}

/**
 * Filesystem-backed `BlobArchive`. Layout: `<dir>/<aa>/0xaa….blob`.
 *
 * Writes use temp-file + rename for atomicity-of-name. fsync is *not*
 * called: durability matters less than correctness here, and the
 * content-addressed naming means a torn file is detected on next read
 * (via `assertVersionedHashMatches`) and treated as a cache miss —
 * the network refetch + rewrite recovers without operator action.
 *
 * The root directory is created (and implicitly probed for
 * writability) at construction so configuration errors surface at
 * boot rather than as per-batch `archive_write_failed` log spam.
 */
export async function createFilesystemBlobArchive(
  opts: FilesystemBlobArchiveOptions
): Promise<BlobArchive> {
  const root = opts.dir;
  await mkdir(root, { recursive: true });

  return {
    async get(versionedHash) {
      const vh = normalizeVersionedHash(versionedHash);
      const { file } = pathsFor(root, vh);
      let handle;
      try {
        handle = await open(file, 'r');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
      try {
        // Size-check via the open handle (TOCTOU-safe) before
        // buffering. Refuses to read a wrong-size file into memory
        // — surfaces as `VersionedHashMismatch` so the multi-source
        // layer logs `source_lied(archive)` and falls through to
        // the network just like a content mismatch.
        const stat = await handle.stat();
        if (stat.size !== FULL_BLOB_BYTE_LENGTH) {
          throw new VersionedHashMismatch(
            `archive entry size ${stat.size} != ${FULL_BLOB_BYTE_LENGTH} for ${vh}`
          );
        }
        const bytes = new Uint8Array(FULL_BLOB_BYTE_LENGTH);
        const { bytesRead } = await handle.read(
          bytes,
          0,
          FULL_BLOB_BYTE_LENGTH,
          0
        );
        if (bytesRead !== FULL_BLOB_BYTE_LENGTH) {
          throw new VersionedHashMismatch(
            `archive short read: ${bytesRead} of ${FULL_BLOB_BYTE_LENGTH} for ${vh}`
          );
        }
        assertVersionedHashMatches(bytes, versionedHash);
        return bytes;
      } finally {
        await handle.close();
      }
    },

    async put(versionedHash, bytes) {
      const vh = normalizeVersionedHash(versionedHash);
      const { shardDir, file } = pathsFor(root, vh);
      await mkdir(shardDir, { recursive: true });
      const tmp = `${file}.tmp.${randomUUID()}`;
      let published = false;
      try {
        const handle = await open(tmp, 'w');
        try {
          await handle.writeFile(bytes);
        } finally {
          await handle.close();
        }
        await rename(tmp, file);
        published = true;
      } finally {
        if (!published) {
          // Covers both "write failed" and "rename failed after a
          // successful write" — without this branch, a failed rename
          // would leave `<file>.tmp.<uuid>` on disk forever.
          await unlink(tmp).catch(() => {});
        }
      }
    },
  };
}
