/**
 * Backend parameterizations for the shared conformance suite.
 *
 * The Postgres parameterization runs when `BAMSTORE_PG_URL` is set
 * (e.g. pointing at a local `docker run postgres` or the CI test
 * container); otherwise it skips with `describe.skipIf`, so dev
 * machines without Docker still pass the suite.
 */

import { describe } from 'vitest';
import pg from 'pg';

import { createMemoryStore, PostgresBamStore, SqliteBamStore } from '../src/index.js';
import { runConformance } from './conformance.js';

describe('bam-store conformance — memory backend', () => {
  runConformance(() => createMemoryStore());
});

describe('bam-store conformance — sqlite backend', () => {
  runConformance(() => new SqliteBamStore(':memory:'));
});

const PG_URL = process.env.BAMSTORE_PG_URL;

describe.skipIf(!PG_URL)('bam-store conformance — postgres backend', () => {
  // Truncate all tables before each store is handed out so tests are
  // isolated against the shared database. Tables are guaranteed to
  // exist after the first PostgresBamStore constructor runs.
  const resetPool = PG_URL ? new pg.Pool({ connectionString: PG_URL }) : null;
  runConformance(async () => {
    if (resetPool) {
      const c = await resetPool.connect();
      try {
        // First connection initialises schema if needed via a throwaway store.
        const bootstrap = new PostgresBamStore(PG_URL!);
        await bootstrap.close();
        await c.query(
          `TRUNCATE messages, batches, reader_cursor, tag_seq, nonces
           RESTART IDENTITY`
        );
      } finally {
        c.release();
      }
    }
    return new PostgresBamStore(PG_URL!);
  });
});
