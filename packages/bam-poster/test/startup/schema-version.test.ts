import { describe, expect, it } from 'vitest';
import type { Address } from 'bam-sdk';

import { SqliteBamStore } from 'bam-store';
import {
  StartupReconciliationError,
  reconcileSchemaVersion,
} from '../../src/startup/reconcile.js';

/**
 * A freshly-created store tags itself with the current SCHEMA_VERSION
 * and passes reconciliation. A stale DB (simulated by writing an older
 * version directly into `bam_store_schema`) is refused with a
 * StartupReconciliationError. An in-memory store is always current.
 */
describe('reconcileSchemaVersion', () => {
  it('accepts a fresh sqlite store at the current SCHEMA_VERSION', async () => {
    const store = new SqliteBamStore(':memory:');
    await expect(reconcileSchemaVersion(store)).resolves.toBeUndefined();
    await store.close();
  });

  it('rejects a stale sqlite store with a StartupReconciliationError', async () => {
    const store = new SqliteBamStore(':memory:');
    // Force the persisted version to 1 to simulate a pre-003 DB.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (store as unknown as { db: any }).db;
    db.prepare('UPDATE bam_store_schema SET version = 1').run();
    await expect(reconcileSchemaVersion(store)).rejects.toBeInstanceOf(
      StartupReconciliationError
    );
    await store.close();
  });

  it('accepts a memory store (no persisted schema to check)', async () => {
    const { createMemoryStore } = await import('bam-store');
    const store = createMemoryStore();
    await expect(reconcileSchemaVersion(store)).resolves.toBeUndefined();
    await store.close();
  });

  it('error message points operators at the drop-and-recreate remedy', async () => {
    const store = new SqliteBamStore(':memory:');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (store as unknown as { db: any }).db;
    db.prepare('UPDATE bam_store_schema SET version = 1').run();
    try {
      await reconcileSchemaVersion(store);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(StartupReconciliationError);
      expect((err as Error).message).toMatch(/drop the store tables/i);
    }
    await store.close();
  });

  // Address unused-import shim
  void (0 as unknown as Address);
});
