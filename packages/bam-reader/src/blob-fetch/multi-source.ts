/**
 * Multi-source blob fetch orchestrator.
 *
 * Source order: local archive (when configured) → beacon API → Blobscan.
 * Each source is independently hash-checked before bytes are returned.
 * Returns `null` only when all configured sources returned `null`; if
 * every source returned wrong-hash bytes (`VersionedHashMismatch`),
 * emits `all_sources_lied` so the caller can distinguish "no data
 * anywhere" from "blob_unreachable / sources hostile".
 *
 * On a successful network fetch (beacon or Blobscan), bytes are written
 * back into the archive when one is configured. Archive write failures
 * are logged and swallowed — the archive is a cache, not authoritative.
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

export interface BlobSources {
  beaconUrl?: string;
  blobscanUrl?: string;
  /**
   * Local archive. Read first; written back on network success. Swap
   * implementations to change the storage substrate (filesystem, S3,
   * DB-resident bytea, …) without touching the orchestrator.
   */
  archive?: BlobArchive;
}

export interface MultiSourceOptions {
  versionedHash: Bytes32;
  parentBeaconBlockRoot: Bytes32 | null;
  sources: BlobSources;
  fetchImpl?: FetchLike;
  logger?: BlobSourceLogger;
}

function errString(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function fetchBlob(opts: MultiSourceOptions): Promise<Uint8Array | null> {
  const log = opts.logger ?? (() => {});
  const vh = opts.versionedHash;
  let triedAny = false;
  let allLied = true;

  /**
   * Run one source. Updates `triedAny`/`allLied` consistently:
   * - bytes → return; caller short-circuits.
   * - null  → tried but had no data; `allLied = false`.
   * - VersionedHashMismatch → log + treat as no-data for this source,
   *   but keep `allLied = true` so a fully-hostile fan-in surfaces.
   *
   * Non-mismatch errors from network sources rethrow (the loop layer
   * classifies as `blob_unreachable`). The archive is exempt — a cache
   * read error never blocks a network fallback.
   */
  const trySource = async (
    name: BlobSourceName,
    fetcher: () => Promise<Uint8Array | null>
  ): Promise<Uint8Array | null> => {
    triedAny = true;
    try {
      const got = await fetcher();
      if (got !== null) return got;
      allLied = false;
      return null;
    } catch (err) {
      if (err instanceof VersionedHashMismatch) {
        log({ kind: 'source_lied', source: name, versionedHash: vh });
        return null;
      }
      if (name === 'archive') {
        log({ kind: 'archive_read_failed', versionedHash: vh, error: errString(err) });
        allLied = false;
        return null;
      }
      throw err;
    }
  };

  const archive = opts.sources.archive;
  if (archive) {
    const got = await trySource('archive', () => archive.get(vh));
    if (got !== null) {
      log({ kind: 'archive_hit', versionedHash: vh });
      return got;
    }
  }

  let networkBytes: Uint8Array | null = null;
  if (opts.sources.beaconUrl && opts.parentBeaconBlockRoot) {
    networkBytes = await trySource('beacon', () =>
      fetchFromBeaconApi({
        beaconUrl: opts.sources.beaconUrl!,
        parentBeaconBlockRoot: opts.parentBeaconBlockRoot!,
        versionedHash: vh,
        fetchImpl: opts.fetchImpl,
      })
    );
  }
  if (networkBytes === null && opts.sources.blobscanUrl) {
    networkBytes = await trySource('blobscan', () =>
      fetchFromBlobscan({
        baseUrl: opts.sources.blobscanUrl!,
        versionedHash: vh,
        fetchImpl: opts.fetchImpl,
      })
    );
  }

  if (networkBytes !== null) {
    if (archive) {
      try {
        await archive.put(vh, networkBytes);
      } catch (err) {
        log({ kind: 'archive_write_failed', versionedHash: vh, error: errString(err) });
      }
    }
    return networkBytes;
  }

  if (triedAny && allLied) {
    log({ kind: 'all_sources_lied', versionedHash: vh });
  }
  return null;
}
