/**
 * Beacon API blob fetch — primary blob source.
 *
 * The flow has two HTTP hops:
 *  1. `/eth/v1/beacon/headers?parent_root=<parentBeaconBlockRoot>` →
 *     resolves the slot of the block whose `parent_root` matches the
 *     execution payload's `parentBeaconBlockRoot` field.
 *  2. `/eth/v1/beacon/blob_sidecars/<slot>` → returns one sidecar per
 *     blob in the block. We pick the sidecar whose
 *     `kzg_commitment → versioned_hash` matches the requested
 *     `versionedHash`, then **recompute the versioned hash from the
 *     blob bytes** and assert equality. No "single sidecar ⇒ assume
 *     it's ours" leniency (red-team C-2): the source must be
 *     authoritative, not best-effort.
 */

import { commitmentsToVersionedHashes } from 'viem';
import type { Bytes32 } from 'bam-sdk';

import { assertVersionedHashMatches } from './versioned-hash.js';

export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string> }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface BeaconFetchOptions {
  beaconUrl: string;
  parentBeaconBlockRoot: Bytes32;
  versionedHash: Bytes32;
  /** Optional injected `fetch` for tests; defaults to global `fetch`. */
  fetchImpl?: FetchLike;
}

interface BeaconHeaderEntry {
  header?: { message?: { slot?: string | number } };
  message?: { slot?: string | number };
  slot?: string | number;
}

interface BeaconSidecar {
  kzg_commitment?: string;
  blob?: string;
}

function trimSlash(s: string): string {
  return s.replace(/\/$/, '');
}

function ensure0x(hex: string): string {
  return hex.startsWith('0x') ? hex : `0x${hex}`;
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (cleaned.length % 2 !== 0) {
    throw new RangeError('invalid hex (odd length)');
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function findSlotForParentRoot(
  base: string,
  parentRoot: string,
  fetchImpl: FetchLike
): Promise<string | null> {
  const url = `${base}/eth/v1/beacon/headers?parent_root=${encodeURIComponent(
    parentRoot
  )}`;
  const res = await fetchImpl(url);
  if (!res.ok) return null;
  const data = (await res.json()) as { data?: BeaconHeaderEntry[] };
  const headers = data?.data;
  if (!Array.isArray(headers) || headers.length === 0) return null;
  const slot =
    headers[0]?.header?.message?.slot ??
    headers[0]?.message?.slot ??
    headers[0]?.slot;
  if (slot === undefined || slot === null) return null;
  return String(slot);
}

/**
 * Fetch the blob bytes whose KZG commitment yields `versionedHash`,
 * via the configured beacon API. Returns `null` when the beacon side
 * does not have the data (block missing, slot lookup failed, sidecar
 * for that hash absent). Throws `VersionedHashMismatch` if the source
 * returns bytes that do not hash back to the requested versioned hash.
 */
export async function fetchFromBeaconApi(
  opts: BeaconFetchOptions
): Promise<Uint8Array | null> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (!fetchImpl) {
    throw new Error('no global fetch available; pass fetchImpl explicitly');
  }

  const base = trimSlash(opts.beaconUrl);
  const parentRoot = ensure0x(opts.parentBeaconBlockRoot);
  const target = ensure0x(opts.versionedHash).toLowerCase();

  const slot = await findSlotForParentRoot(base, parentRoot, fetchImpl);
  if (!slot) return null;

  const res = await fetchImpl(`${base}/eth/v1/beacon/blob_sidecars/${slot}`);
  if (!res.ok) return null;

  const json = (await res.json()) as { data?: BeaconSidecar[] };
  const sidecars = json?.data ?? [];
  if (sidecars.length === 0) return null;

  for (const sc of sidecars) {
    const commitment = sc.kzg_commitment;
    if (!commitment || !commitment.startsWith('0x') || !sc.blob) continue;
    // Don't let a single malformed sidecar (bad hex, off-by-one
    // commitment length, garbled blob) take the whole fetch down —
    // skip it and keep looking. A versioned-hash mismatch is *not*
    // skipped: it's an authoritative signal that the source is
    // lying, and the orchestrator needs to see it. (cubic C-1)
    let vh: string | undefined;
    let bytes: Uint8Array | undefined;
    try {
      const [vhCandidate] = commitmentsToVersionedHashes({
        commitments: [commitment as `0x${string}`],
      });
      if (typeof vhCandidate !== 'string') continue;
      vh = vhCandidate;
      if (vh.toLowerCase() !== target) continue;
      bytes = hexToBytes(sc.blob);
    } catch {
      continue;
    }
    // Authoritative recompute on every successful fetch — never trust
    // the source's keying, even when it appears self-consistent.
    assertVersionedHashMatches(bytes!, opts.versionedHash);
    return bytes!;
  }
  return null;
}
