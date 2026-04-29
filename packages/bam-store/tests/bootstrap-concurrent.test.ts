/**
 * Concurrent bootstrap: two `PostgresBamStore.open()` calls hitting an
 * empty real Postgres at the same time must both succeed without
 * duplicate `bam_store_schema` rows and without colliding on Postgres's
 * system catalogs (`pg_type_typname_nsp_index` etc).
 *
 * `CREATE TABLE IF NOT EXISTS` is not race-safe in Postgres on its own;
 * the bootstrap path serialises via `pg_advisory_xact_lock`, and this
 * test pins that contract.
 *
 * Env-gated against real Postgres (set `BAM_TEST_PG_URL`). PGLite is
 * single-process so concurrent open against one PGLite instance is not
 * a meaningful test case here.
 */

import { describe, expect, it } from 'vitest';

import { SCHEMA_VERSION } from '../src/index.js';
import { createPostgresStoreFromUrl } from '../src/db-store.js';

const PG_URL = process.env.BAM_TEST_PG_URL;

describe('PostgresBamStore — concurrent bootstrap (real Postgres)', () => {
  if (!PG_URL) {
    it.skip(
      'concurrent bootstrap test skipped — set BAM_TEST_PG_URL to run',
      () => {}
    );
    return;
  }

  it('two parallel open() calls against an empty DB both succeed', async () => {
    // Wipe any prior tables so we exercise the bootstrap path on a
    // truly empty DB. Mirrors bootstrap-smoke.test.ts.
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

    const [a, b] = await Promise.all([
      createPostgresStoreFromUrl(PG_URL),
      createPostgresStoreFromUrl(PG_URL),
    ]);
    try {
      expect(await a.readSchemaVersion()).toBe(SCHEMA_VERSION);
      expect(await b.readSchemaVersion()).toBe(SCHEMA_VERSION);

      // Probe directly: the singleton table must hold exactly one row.
      const probePool = new pgMod.default.Pool({ connectionString: PG_URL });
      try {
        const res = await probePool.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM bam_store_schema'
        );
        expect(res.rows[0]!.count).toBe('1');
      } finally {
        await probePool.end();
      }
    } finally {
      await a.close();
      await b.close();
    }
  });
});
