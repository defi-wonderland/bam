/**
 * Multi-source blob fetch orchestrator.
 *
 * Source order: local archive (when configured) → beacon API → Blobscan.
 * Each source is independently hash-checked before bytes are returned:
 *  - `null`  → source had no data, try the next.
 *  - `VersionedHashMismatch` → source lied; logged, treated as no data
 *    for that source, try the next.
 *  - bytes   → return immediately.
 *
 * On a successful network fetch (beacon or Blobscan), bytes are written
 * back into the archive when one is configured. Archive write failures
 * are logged and swallowed — the archive is a cache, not authoritative.
 *
 * Returns `null` only when *all* configured sources returned `null`
 * without producing usable bytes. If *every* source we tried lied about
 * the bytes, emits `all_sources_lied` and returns `null` so the caller
 * surfaces it as `blob_unreachable` rather than halting.
 *
 * With no sources configured, returns `null` immediately.
 */

import type { Bytes32 } from 'bam-sdk';

import { VersionedHashMismatch } from '../errors.js';
import type { BlobArchive } from './archive.js';
import { fetchFromBeaconApi, type FetchLike } from './beacon.js';
import { fetchFromBlobscan } from './blobscan.js';

export type BlobSourceLogger = (event: BlobSourceEvent) => void;

export type BlobSourceName = 'archive' | 'beacon' | 'blobscan';

export type BlobSourceEvent =
  | { kind: 'source_lied'; source: BlobSourceName; versionedHash: Bytes32 }
  | { kind: 'all_sources_lied'; versionedHash: Bytes32 }
  | { kind: 'archive_hit'; versionedHash: Bytes32 }
  | { kind: 'archive_read_failed'; versionedHash: Bytes32; error: string }
  | { kind: 'archive_write_failed'; versionedHash: Bytes32; error: string };

export interface MultiSourceOptions {
  versionedHash: Bytes32;
  parentBeaconBlockRoot: Bytes32 | null;
  sources: {
    beaconUrl?: string;
    blobscanUrl?: string;
  };
  /**
   * Optional local archive. Read first; written back on network success.
   * Swap implementations to change the storage substrate (filesystem,
   * S3, DB-resident bytea, …) without touching the orchestrator.
   */
  archive?: BlobArchive;
  fetchImpl?: FetchLike;
  logger?: BlobSourceLogger;
}

function errString(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function fetchBlob(opts: MultiSourceOptions): Promise<Uint8Array | null> {
  const log = opts.logger ?? (() => {});
  let triedAny = false;
  let allLied = true;

  if (opts.archive) {
    triedAny = true;
    try {
      const got = await opts.archive.get(opts.versionedHash);
      if (got !== null) {
        log({ kind: 'archive_hit', versionedHash: opts.versionedHash });
        return got;
      }
      allLied = false;
    } catch (err) {
      if (err instanceof VersionedHashMismatch) {
        log({ kind: 'source_lied', source: 'archive', versionedHash: opts.versionedHash });
      } else {
        // Disk/transport error reading the archive — log and fall through
        // to upstream sources. The archive is a cache, not authoritative;
        // a failed read here should never block a network fallback.
        log({
          kind: 'archive_read_failed',
          versionedHash: opts.versionedHash,
          error: errString(err),
        });
        allLied = false;
      }
    }
  }

  let networkBytes: Uint8Array | null = null;

  if (opts.sources.beaconUrl && opts.parentBeaconBlockRoot) {
    triedAny = true;
    try {
      const got = await fetchFromBeaconApi({
        beaconUrl: opts.sources.beaconUrl,
        parentBeaconBlockRoot: opts.parentBeaconBlockRoot,
        versionedHash: opts.versionedHash,
        fetchImpl: opts.fetchImpl,
      });
      if (got !== null) {
        networkBytes = got;
      } else {
        allLied = false;
      }
    } catch (err) {
      if (err instanceof VersionedHashMismatch) {
        log({ kind: 'source_lied', source: 'beacon', versionedHash: opts.versionedHash });
      } else {
        throw err;
      }
    }
  }

  if (networkBytes === null && opts.sources.blobscanUrl) {
    triedAny = true;
    try {
      const got = await fetchFromBlobscan({
        baseUrl: opts.sources.blobscanUrl,
        versionedHash: opts.versionedHash,
        fetchImpl: opts.fetchImpl,
      });
      if (got !== null) {
        networkBytes = got;
      } else {
        allLied = false;
      }
    } catch (err) {
      if (err instanceof VersionedHashMismatch) {
        log({ kind: 'source_lied', source: 'blobscan', versionedHash: opts.versionedHash });
      } else {
        throw err;
      }
    }
  }

  if (networkBytes !== null) {
    if (opts.archive) {
      try {
        await opts.archive.put(opts.versionedHash, networkBytes);
      } catch (err) {
        log({
          kind: 'archive_write_failed',
          versionedHash: opts.versionedHash,
          error: errString(err),
        });
      }
    }
    return networkBytes;
  }

  if (triedAny && allLied) {
    log({ kind: 'all_sources_lied', versionedHash: opts.versionedHash });
  }
  return null;
}
