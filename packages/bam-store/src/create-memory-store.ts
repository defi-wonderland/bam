import { PGlite } from '@electric-sql/pglite';

import { PostgresBamStore } from './postgres.js';
import type { BamStore } from './types.js';

/**
 * In-memory `BamStore` backed by a fresh in-process PGLite instance.
 *
 * Each call returns an isolated database — no persistence between
 * factories, no shared state. The returned store implements the same
 * `BamStore` surface as the real-Postgres path because it *is* the
 * same `PostgresBamStore` adapter underneath.
 */
export async function createMemoryStore(): Promise<BamStore> {
  return PostgresBamStore.open(new PGlite());
}
