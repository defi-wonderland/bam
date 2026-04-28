import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { PostgresBamStore } from 'bam-store';
import {
  StartupReconciliationError,
  reconcileSchemaVersion,
} from '../../src/startup/reconcile.js';

/**
 * A freshly-created store tags itself with the current SCHEMA_VERSION
 * and passes reconciliation. A stale DB (simulated by writing an older
 * version directly into `bam_store_schema`) is refused with a
 * StartupReconciliationError. The in-memory `createMemoryStore()` is
 * always current because it constructs a fresh PGLite instance.
 */
describe('reconcileSchemaVersion', () => {
  it('accepts a fresh PGLite-backed store at the current SCHEMA_VERSION', async () => {
    const db = new PGlite();
    const store = await PostgresBamStore.open(db);
    try {
      await expect(reconcileSchemaVersion(store)).resolves.toBeUndefined();
    } finally {
      await store.close();
      await db.close();
    }
  });

  it('rejects a stale store with a StartupReconciliationError', async () => {
    const db = new PGlite();
    const store = await PostgresBamStore.open(db);
    try {
      // Force the persisted version to 1 to simulate a pre-current DB.
      // The store has bootstrapped by the time `readSchemaVersion`
      // resolves, so it's safe to mutate the table directly here.
      await store.readSchemaVersion();
      await db.exec(`UPDATE bam_store_schema SET version = 1`);
      await expect(reconcileSchemaVersion(store)).rejects.toBeInstanceOf(
        StartupReconciliationError
      );
    } finally {
      await store.close();
      await db.close();
    }
  });

  it('accepts a memory store (constructs at the current schema)', async () => {
    const { createMemoryStore } = await import('bam-store');
    const store = await createMemoryStore();
    try {
      await expect(reconcileSchemaVersion(store)).resolves.toBeUndefined();
    } finally {
      await store.close();
    }
  });

  it('error message points operators at the drop-and-recreate remedy', async () => {
    const db = new PGlite();
    const store = await PostgresBamStore.open(db);
    try {
      await store.readSchemaVersion();
      await db.exec(`UPDATE bam_store_schema SET version = 1`);
      await reconcileSchemaVersion(store);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(StartupReconciliationError);
      expect((err as Error).message).toMatch(/drop the store tables/i);
    } finally {
      await store.close();
      await db.close();
    }
  });
});
