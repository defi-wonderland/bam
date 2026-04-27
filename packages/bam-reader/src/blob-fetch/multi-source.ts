/**
 * Multi-source blob fetch orchestrator.
 *
 * Tries the configured beacon API first; if it returns `null` (no data)
 * or rejects its bytes (`VersionedHashMismatch`), falls back to
 * Blobscan. Returns `null` only when *all* configured sources returned
 * `null` without any source rejecting the bytes; if *every* source we
 * tried lied about the bytes, the orchestrator emits a structured log
 * indication ("all sources lied") and returns `null` so the caller
 * surfaces it as `blob_unreachable` rather than halting.
 *
 * With no sources configured, returns `null` immediately.
 */

import type { Bytes32 } from 'bam-sdk';

import { VersionedHashMismatch } from '../errors.js';
import { fetchFromBeaconApi, type FetchLike } from './beacon.js';
import { fetchFromBlobscan } from './blobscan.js';

export type BlobSourceLogger = (event: BlobSourceEvent) => void;

export type BlobSourceEvent =
  | { kind: 'source_lied'; source: 'beacon' | 'blobscan'; versionedHash: Bytes32 }
  | { kind: 'all_sources_lied'; versionedHash: Bytes32 };

export interface MultiSourceOptions {
  versionedHash: Bytes32;
  parentBeaconBlockRoot: Bytes32 | null;
  sources: {
    beaconUrl?: string;
    blobscanUrl?: string;
  };
  fetchImpl?: FetchLike;
  logger?: BlobSourceLogger;
}

export async function fetchBlob(opts: MultiSourceOptions): Promise<Uint8Array | null> {
  const log = opts.logger ?? (() => {});
  let triedAny = false;
  let allLied = true;

  if (opts.sources.beaconUrl && opts.parentBeaconBlockRoot) {
    triedAny = true;
    try {
      const got = await fetchFromBeaconApi({
        beaconUrl: opts.sources.beaconUrl,
        parentBeaconBlockRoot: opts.parentBeaconBlockRoot,
        versionedHash: opts.versionedHash,
        fetchImpl: opts.fetchImpl,
      });
      if (got !== null) return got;
      allLied = false;
    } catch (err) {
      if (err instanceof VersionedHashMismatch) {
        log({ kind: 'source_lied', source: 'beacon', versionedHash: opts.versionedHash });
      } else {
        throw err;
      }
    }
  }

  if (opts.sources.blobscanUrl) {
    triedAny = true;
    try {
      const got = await fetchFromBlobscan({
        baseUrl: opts.sources.blobscanUrl,
        versionedHash: opts.versionedHash,
        fetchImpl: opts.fetchImpl,
      });
      if (got !== null) return got;
      allLied = false;
    } catch (err) {
      if (err instanceof VersionedHashMismatch) {
        log({ kind: 'source_lied', source: 'blobscan', versionedHash: opts.versionedHash });
      } else {
        throw err;
      }
    }
  }

  if (triedAny && allLied) {
    log({ kind: 'all_sources_lied', versionedHash: opts.versionedHash });
  }
  return null;
}
