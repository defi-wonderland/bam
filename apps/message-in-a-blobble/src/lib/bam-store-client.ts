/**
 * Lazy-singleton `bam-store` adapter for the demo's API routes.
 *
 * Resolves the backend from env in priority order:
 *   1. `BAM_STORE_POSTGRES_URL` / Vercel's `POSTGRES_URL` → real
 *      Postgres via `bam-store`.
 *   2. Otherwise → in-process PGLite via `createMemoryStore()`. State
 *      lives only in the running process; suitable for local dev and
 *      ephemeral preview deploys.
 *
 * The Reader (or any writer) populates `confirmed` rows; this demo
 * reads them back. The Poster, when running co-located, ALSO writes
 * into the same store via `bam-store`'s adapter — convergence on
 * shared state is the substrate's job, not the route handler's.
 */

import {
  createDbStore,
  createMemoryStore,
  type BamStore,
} from 'bam-store';

// Cache the in-flight promise so concurrent first-call routes share
// one bootstrap rather than racing to construct duplicate adapters.
let cached: Promise<BamStore> | null = null;

async function buildStore(): Promise<BamStore> {
  const postgresUrl =
    process.env.BAM_STORE_POSTGRES_URL ?? process.env.POSTGRES_URL;
  if (postgresUrl && postgresUrl.length > 0) {
    return createDbStore({ postgresUrl });
  }
  return createMemoryStore();
}

export function getBamStore(): Promise<BamStore> {
  if (cached === null) {
    cached = buildStore().catch((err) => {
      // Don't poison the cache with a rejected promise — a future
      // request should retry the bootstrap.
      cached = null;
      throw err;
    });
  }
  return cached;
}

/** Test-only reset hook. */
export function _clearBamStoreForTests(): void {
  cached = null;
}
