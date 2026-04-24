/**
 * Codec for `BatchRow.messageSnapshot`. Stored as a JSON-encoded string in
 * `batches.message_snapshot`. `nonce` (`bigint`) is encoded with the same
 * 20-character zero-padded format the messages table uses, so a snapshot
 * reader can compare nonces lexicographically without re-encoding.
 *
 * The encoded form is the on-disk shape. Adapters write the exact string
 * produced by `encodeMessageSnapshot` and a `'[]'` literal compares
 * equal across writers (matters for the empty-snapshot guard in
 * `upsertBatch`).
 */

import type { Address, Bytes32 } from 'bam-sdk';

import type { BatchMessageSnapshotEntry } from './types.js';
import { decodeNonce, encodeNonce } from './nonce-codec.js';

interface EncodedEntry {
  author: string;
  nonce: string;
  messageId: string;
  messageHash: string;
  messageIndexWithinBatch: number;
}

export function encodeMessageSnapshot(entries: BatchMessageSnapshotEntry[]): string {
  if (entries.length === 0) return '[]';
  const out: EncodedEntry[] = entries.map((e) => ({
    author: e.author.toLowerCase(),
    nonce: encodeNonce(e.nonce),
    messageId: e.messageId,
    messageHash: e.messageHash,
    messageIndexWithinBatch: e.messageIndexWithinBatch,
  }));
  return JSON.stringify(out);
}

export function decodeMessageSnapshot(text: string): BatchMessageSnapshotEntry[] {
  if (text === '' || text === '[]') return [];
  const parsed = JSON.parse(text) as EncodedEntry[];
  return parsed.map((e) => ({
    author: e.author as Address,
    nonce: decodeNonce(e.nonce),
    messageId: e.messageId as Bytes32,
    messageHash: e.messageHash as Bytes32,
    messageIndexWithinBatch: e.messageIndexWithinBatch,
  }));
}
