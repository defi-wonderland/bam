/**
 * Idempotent bootstrap: opening a `PostgresBamStore` against the same
 * underlying database twice does not duplicate `bam_store_schema` rows
 * and does not throw on the `CREATE TABLE IF NOT EXISTS` /
 * `CREATE INDEX IF NOT EXISTS` statements. The singleton-row CHECK
 * is the load-bearing guard; this test pins it.
 */

import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

import { PostgresBamStore, SCHEMA_VERSION } from '../src/index.js';

describe('PostgresBamStore — idempotent bootstrap', () => {
  it('reopening against the same PGLite preserves a single bam_store_schema row', async () => {
    const db = new PGlite();
    try {
      const a = await PostgresBamStore.open(db);
      const va = await a.readSchemaVersion();
      expect(va).toBe(SCHEMA_VERSION);
      await a.close();

      const b = await PostgresBamStore.open(db);
      const vb = await b.readSchemaVersion();
      expect(vb).toBe(SCHEMA_VERSION);
      await b.close();

      // Direct probe: exactly one row in the singleton table.
      const res = await db.query<{ count: number | string }>(
        `SELECT COUNT(*)::int AS count FROM bam_store_schema`
      );
      expect(Number(res.rows[0]!.count)).toBe(1);
    } finally {
      await db.close();
    }
  });
});
