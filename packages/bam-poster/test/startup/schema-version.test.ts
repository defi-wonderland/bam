import { describe, expect, it } from 'vitest';
import type { Address } from 'bam-sdk';

import { SqlitePosterStore } from '../../src/pool/sqlite.js';
import {
  StartupReconciliationError,
  reconcileSchemaVersion,
} from '../../src/startup/reconcile.js';

/**
 * A freshly-created store tags itself with the current SCHEMA_VERSION
 * and passes reconciliation. A v1-shaped DB (simulated by writing
 * version=1 directly into `poster_schema`) is refused with a
 * StartupReconciliationError. An in-memory store is always current.
 */
describe('reconcileSchemaVersion', () => {
  it('accepts a fresh v2 sqlite store', async () => {
    const store = new SqlitePosterStore(':memory:');
    await expect(reconcileSchemaVersion(store)).resolves.toBeUndefined();
    await store.close();
  });

  it('rejects a v1-shaped sqlite store with a StartupReconciliationError', async () => {
    const store = new SqlitePosterStore(':memory:');
    // Force the persisted version to v1 to simulate an upgrade from a
    // 001-era Poster.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (store as unknown as { db: any }).db;
    db.prepare('UPDATE poster_schema SET version = 1').run();
    await expect(reconcileSchemaVersion(store)).rejects.toBeInstanceOf(
      StartupReconciliationError
    );
    await store.close();
  });

  it('accepts a memory store (no persisted schema to check)', async () => {
    const { createMemoryStore } = await import('../../src/pool/memory-store.js');
    const store = createMemoryStore();
    await expect(reconcileSchemaVersion(store)).resolves.toBeUndefined();
    await store.close();
  });

  it('error message points operators at the drop-and-recreate remedy', async () => {
    const store = new SqlitePosterStore(':memory:');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (store as unknown as { db: any }).db;
    db.prepare('UPDATE poster_schema SET version = 1').run();
    try {
      await reconcileSchemaVersion(store);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(StartupReconciliationError);
      expect((err as Error).message).toMatch(/drop the pool tables/i);
    }
    await store.close();
  });

  // Address unused-import shim
  void (0 as unknown as Address);
});
