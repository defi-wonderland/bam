/**
 * Backend parameterizations for the shared conformance suite.
 *
 * T004 ships every backend here as `describe.skip` — tests count as
 * pending until the adapter actually implements the unified-schema
 * methods. T005 un-skips memory; T006 un-skips SQLite; T007 un-skips
 * Postgres.
 */

import { describe } from 'vitest';

import { createMemoryStore, SqliteBamStore } from '../src/index.js';
import { runConformance } from './conformance.js';

describe.skip('bam-store conformance — memory backend', () => {
  runConformance(() => createMemoryStore());
});

describe.skip('bam-store conformance — sqlite backend', () => {
  runConformance(() => new SqliteBamStore(':memory:'));
});

describe.skip('bam-store conformance — postgres backend', () => {
  // Concrete factory wired up in T007 once the test container is hooked
  // in. Keeping the placeholder keeps the backend list visible.
  runConformance(() => {
    throw new Error('postgres backend factory not wired (T007)');
  });
});
