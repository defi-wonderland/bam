import { PGlite } from '@electric-sql/pglite';

import { PostgresBamStore } from './postgres.js';
import type { BamStore } from './types.js';

/**
 * In-memory `BamStore` backed by a fresh in-process PGLite instance.
 *
 * Each call returns an isolated database — no persistence between
 * factories, no shared state. The returned store implements the same
 * `BamStore` surface as the real-Postgres path because it *is* the
 * same `PostgresBamStore` adapter underneath. The PGLite handle is
 * owned by the store: `store.close()` releases it.
 */
export async function createMemoryStore(): Promise<BamStore> {
  const db = new PGlite();
  try {
    return await PostgresBamStore.open(db, { cleanup: () => db.close() });
  } catch (err) {
    // open() runs DDL; if anything throws we'd otherwise leak the PGLite
    // handle because cleanup is only attached on the returned store.
    await db.close().catch(() => {});
    throw err;
  }
}
