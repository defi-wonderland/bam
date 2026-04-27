/**
 * Lazy-singleton `bam-store` adapter for the demo's API routes.
 *
 * Resolves the backend from env in priority order:
 *   1. `BAM_STORE_POSTGRES_URL` / Vercel's `POSTGRES_URL` → Postgres.
 *   2. `BAM_STORE_DB_URL` (file path or `:memory:`) → SQLite.
 *   3. `./bam-store.db` SQLite default for local dev.
 *
 * The Reader (or any writer) populates `confirmed` rows; this demo
 * reads them back. The Poster, when running co-located, ALSO writes
 * into the same store via `bam-store`'s adapter — convergence on
 * shared state is the substrate's job, not the route handler's.
 */

import { createDbStore, type BamStore } from 'bam-store';

let cached: BamStore | null = null;

function buildStore(): BamStore {
  const postgresUrl =
    process.env.BAM_STORE_POSTGRES_URL ?? process.env.POSTGRES_URL;
  if (postgresUrl && postgresUrl.length > 0) {
    return createDbStore({ postgresUrl });
  }
  const sqlitePath = process.env.BAM_STORE_DB_URL ?? './bam-store.db';
  return createDbStore({ sqlitePath });
}

export function getBamStore(): BamStore {
  if (cached === null) {
    cached = buildStore();
  }
  return cached;
}

/** Test-only reset hook. */
export function _clearBamStoreForTests(): void {
  cached = null;
}
