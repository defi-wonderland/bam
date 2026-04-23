import type { Bytes32 } from 'bam-sdk';

/**
 * Canonicalize a Bytes32 tag to lowercase-hex form. All `contentTag`
 * values entering the library (env allowlist, ingest envelope, HTTP
 * query params, internal test hooks) are normalized here so the store
 * persists and queries a single canonical representation.
 *
 * Hex casing is not semantically significant — `0xABC…` and `0xabc…`
 * are the same bytes — but SQLite/Postgres TEXT equality is case
 * sensitive, so a mismatch between the allowlist casing and the
 * envelope casing would strand pending rows indefinitely (per-tag
 * workers run under one casing, inserts land under another).
 */
export function canonicalTag(tag: Bytes32): Bytes32 {
  return tag.toLowerCase() as Bytes32;
}
