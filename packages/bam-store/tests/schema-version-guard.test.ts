/**
 * Schema-version refusal regression: a database whose
 * `bam_store_schema.version` row holds a stale version must NOT be
 * silently bootstrapped to the current `SCHEMA_VERSION`. The store's
 * INSERT ON CONFLICT DO NOTHING preserves the existing row, so a
 * subsequent `readSchemaVersion()` returns the stale value — which is
 * what the Poster's `reconcileSchemaVersion` reads to refuse start-up.
 *
 * Runs against the PGLite factory always; runs against real Postgres
 * when `BAM_TEST_PG_URL` is set (visibly skipped otherwise).
 */

import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import pg from 'pg';

import { PostgresBamStore, SCHEMA_VERSION } from '../src/index.js';
import { createPostgresStoreFromUrl } from '../src/db-store.js';

const PG_URL = process.env.BAM_TEST_PG_URL;

async function seedStaleVersionPglite(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS bam_store_schema (
      id INTEGER NOT NULL PRIMARY KEY,
      version INTEGER NOT NULL,
      CONSTRAINT bam_store_schema_singleton CHECK (id = 1)
    );
    INSERT INTO bam_store_schema (id, version) VALUES (1, ${SCHEMA_VERSION - 1});
  `);
  return db;
}

describe('schema-version refusal — pglite backend', () => {
  it('readSchemaVersion returns the seeded stale version (not auto-bumped)', async () => {
    const db = await seedStaleVersionPglite();
    const store = await PostgresBamStore.open(db);
    try {
      const v = await store.readSchemaVersion();
      expect(v).toBe(SCHEMA_VERSION - 1);
      expect(v).not.toBe(SCHEMA_VERSION);
    } finally {
      await store.close();
      await db.close();
    }
  });
});

describe.skipIf(!PG_URL)('schema-version refusal — postgres backend', () => {
  it('readSchemaVersion returns the seeded stale version (BAM_TEST_PG_URL)', async () => {
    const pool = new pg.Pool({ connectionString: PG_URL! });
    const c = await pool.connect();
    try {
      // Reset to a known stale state.
      await c.query(`
        CREATE TABLE IF NOT EXISTS bam_store_schema (
          id INTEGER NOT NULL PRIMARY KEY,
          version INTEGER NOT NULL,
          CONSTRAINT bam_store_schema_singleton CHECK (id = 1)
        )
      `);
      await c.query(`DELETE FROM bam_store_schema`);
      await c.query(`INSERT INTO bam_store_schema (id, version) VALUES (1, $1)`, [
        SCHEMA_VERSION - 1,
      ]);
    } finally {
      c.release();
    }

    const store = await createPostgresStoreFromUrl(PG_URL!);
    try {
      const v = await store.readSchemaVersion();
      expect(v).toBe(SCHEMA_VERSION - 1);
    } finally {
      await store.close();
      await pool.end();
    }
  });
});
