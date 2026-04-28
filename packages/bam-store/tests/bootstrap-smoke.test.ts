/**
 * Zero-setup bootstrap smoke: opening a fresh `PostgresBamStore`
 * against (a) an in-process PGLite instance and (b) an empty real
 * Postgres database (env-gated) must complete a full `withTxn` cycle
 * — insertPending → listPendingByTag → setNonce — without any prior
 * setup, migration, or codegen step. The `bam_store_schema` row must
 * be present with `version = SCHEMA_VERSION` immediately after first
 * construction.
 */

import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import type { Address, Bytes32 } from 'bam-sdk';

import { PostgresBamStore, SCHEMA_VERSION } from '../src/index.js';
import { createPostgresStoreFromUrl } from '../src/db-store.js';

const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const SENDER = ('0x' + '11'.repeat(20)) as Address;

async function exerciseFullCycle(store: PostgresBamStore): Promise<void> {
  await store.withTxn(async (txn) => {
    await txn.insertPending({
      contentTag: TAG,
      sender: SENDER,
      nonce: 1n,
      contents: new Uint8Array(40),
      signature: new Uint8Array(65),
      messageHash: ('0x' + '77'.repeat(32)) as Bytes32,
      ingestedAt: 1_000,
      ingestSeq: 1,
    });
    const pending = await txn.listPendingByTag(TAG);
    expect(pending).toHaveLength(1);
    expect(pending[0].nonce).toBe(1n);
    await txn.setNonce({
      sender: SENDER,
      lastNonce: 1n,
      lastMessageHash: ('0x' + '77'.repeat(32)) as Bytes32,
    });
    const nonce = await txn.getNonce(SENDER);
    expect(nonce?.lastNonce).toBe(1n);
  });
}

describe('zero-setup bootstrap smoke — PGLite', () => {
  it('opens a fresh PGLite-backed store and runs a full withTxn cycle', async () => {
    const db = new PGlite();
    const store = await PostgresBamStore.open(db);
    try {
      const v = await store.readSchemaVersion();
      expect(v).toBe(SCHEMA_VERSION);
      await exerciseFullCycle(store);
    } finally {
      await store.close();
      await db.close();
    }
  });
});

const PG_URL = process.env.BAM_TEST_PG_URL;

describe('zero-setup bootstrap smoke — real Postgres', () => {
  if (!PG_URL) {
    it.skip(
      'real-Postgres bootstrap smoke skipped — set BAM_TEST_PG_URL to run',
      () => {}
    );
    return;
  }
  it('opens against an empty Postgres and runs a full withTxn cycle', async () => {
    // Wipe any existing tables so we exercise the bootstrap path on a
    // truly empty DB. This mirrors the deploy story: point at an empty
    // database and the adapter creates everything.
    const pgMod = await import('pg');
    const pool = new pgMod.default.Pool({ connectionString: PG_URL });
    const c = await pool.connect();
    try {
      await c.query(`DROP TABLE IF EXISTS messages, batches, reader_cursor,
        tag_seq, nonces, bam_store_schema CASCADE`);
    } finally {
      c.release();
      await pool.end();
    }

    const store = await createPostgresStoreFromUrl(PG_URL);
    try {
      const v = await store.readSchemaVersion();
      expect(v).toBe(SCHEMA_VERSION);
      await exerciseFullCycle(store);
    } finally {
      await store.close();
    }
  });
});
