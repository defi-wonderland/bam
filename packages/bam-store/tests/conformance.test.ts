/**
 * Backend parameterizations for the shared conformance suite.
 *
 * The real-Postgres parameterization runs when `BAM_TEST_PG_URL` is set
 * (e.g. pointing at a local `docker run postgres` or the CI test
 * container). When the env var is absent it surfaces a visible
 * `it.skip` that names the env var, so the absence is auditable in CI
 * output rather than silently dropped.
 */

import { PGlite } from '@electric-sql/pglite';
import { describe, it } from 'vitest';
import pg from 'pg';

import { PostgresBamStore } from '../src/index.js';
import { createPostgresStoreFromUrl } from '../src/db-store.js';
import { runConformance } from './conformance.js';

describe('bam-store conformance — pglite backend', () => {
  runConformance(() => PostgresBamStore.open(new PGlite()));
});

const PG_URL = process.env.BAM_TEST_PG_URL;

describe('bam-store conformance — postgres backend (real)', () => {
  if (!PG_URL) {
    it.skip(
      'real-Postgres factory skipped — set BAM_TEST_PG_URL to run',
      () => {}
    );
    return;
  }
  // Truncate all tables before each store is handed out so tests are
  // isolated against the shared database. Tables are guaranteed to
  // exist after the first PostgresBamStore constructor runs.
  const resetPool = new pg.Pool({ connectionString: PG_URL });
  runConformance(async () => {
    const c = await resetPool.connect();
    try {
      // First connection initialises schema if needed via a throwaway store.
      const bootstrap = await createPostgresStoreFromUrl(PG_URL);
      await bootstrap.close();
      await c.query(
        `TRUNCATE messages, batches, reader_cursor, tag_seq, nonces
         RESTART IDENTITY`
      );
    } finally {
      c.release();
    }
    return createPostgresStoreFromUrl(PG_URL);
  });
});
