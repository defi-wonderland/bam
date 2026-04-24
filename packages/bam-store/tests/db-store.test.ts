import { afterEach, describe, expect, it } from 'vitest';

import { SqliteBamStore } from '../src/sqlite.js';
import type { BamStore } from '../src/types.js';

/**
 * SQLite-specific DDL + schema-version guards. Behavioural coverage
 * of the store surface is handled by `conformance.test.ts` against
 * each backend; these tests assert structural invariants that matter
 * for SQLite in particular.
 */

const stores: BamStore[] = [];

function newStore(): SqliteBamStore {
  const s = new SqliteBamStore(':memory:');
  stores.push(s);
  return s;
}

afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

describe('SqliteBamStore — schema', () => {
  it('fresh DB self-initialises to the current SCHEMA_VERSION', () => {
    const store = newStore();
    expect(store.readSchemaVersion()).toBe(3);
  });

  it('all unified tables exist on a fresh DB', () => {
    const store = newStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (store as unknown as { db: any }).db;
    const names = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map((r: { name: string }) => r.name);
    for (const t of [
      'bam_store_schema',
      'batches',
      'messages',
      'nonces',
      'reader_cursor',
      'tag_seq',
    ]) {
      expect(names).toContain(t);
    }
  });

  it('none of the legacy `poster_*` tables exist after the unified-schema cut', () => {
    const store = newStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (store as unknown as { db: any }).db;
    const names = new Set(
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
        .all()
        .map((r: { name: string }) => r.name)
    );
    for (const t of [
      'poster_pending',
      'poster_submitted_batches',
      'poster_nonces',
      'poster_tag_seq',
      'poster_schema',
    ]) {
      expect(names.has(t)).toBe(false);
    }
  });
});
