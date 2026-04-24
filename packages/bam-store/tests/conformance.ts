/**
 * Shared conformance suite — the body run against every backend
 * (memory in T005, SQLite in T006, Postgres in T007).
 *
 * Every new behaviour the unified schema introduces gets one `describe`
 * block here. Skipping is handled at the backend level in
 * `conformance.test.ts`; T004 ships with all three backend
 * parameterizations marked `describe.skip`. T005–T007 flip each one to
 * a regular `describe` in order.
 */

import { describe, expect, it } from 'vitest';
import type { Address, Bytes32 } from 'bam-sdk';

import type { BamStore } from '../src/types.js';

export type StoreFactory = () => BamStore | Promise<BamStore>;

/* eslint-disable @typescript-eslint/no-unused-vars */

export function runConformance(make: StoreFactory): void {
  const TAG_A = ('0x' + 'aa'.repeat(32)) as Bytes32;
  const ADDR_1 = ('0x' + '11'.repeat(20)) as Address;
  const ADDR_2 = ('0x' + '22'.repeat(20)) as Address;

  describe('upsert-observed idempotency on (author, nonce)', () => {
    it.todo('second upsert with same (author, nonce) is a no-op merge, not a duplicate row');
  });

  describe('markDuplicate — first-confirmed wins, original not mutated', () => {
    it.todo('a later-arriving (author, nonce) with different bytes becomes a duplicate row; original untouched');
  });

  describe('markReorged cascade', () => {
    it.todo('batch transitions to reorged and every confirmed row under it flips to reorged with invalidatedAt set');
  });

  describe('chain-derived ordering from listMessages', () => {
    it.todo('observed rows sort by (blockNumber, txIndex, messageIndexWithinBatch)');
    it.todo('cursor-based pagination resumes exactly, reproducible across instances');
  });

  describe('batch status transitions', () => {
    it.todo('pending_tx → confirmed on upsertBatch with block_number');
    it.todo('confirmed → reorged via updateBatchStatus with invalidatedAt');
  });

  describe('reader cursor get/set', () => {
    it.todo('getCursor on a fresh chain returns null; set+get round-trips; overwrite on re-set');
  });

  describe('cross-component write interleaving in one withTxn', () => {
    it.todo('Poster marks submitted while Reader upserts observed; serialised, no lost writes');
  });

  describe('bulk-ingest many messages in a single withTxn', () => {
    it.todo('upsertObserved for every message decoded from a blob within one transaction');
  });
}
