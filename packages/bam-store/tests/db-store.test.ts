import { afterEach, describe, expect, it } from 'vitest';

import { createDbStore } from '../src/index.js';
import type { BamStore, DbStoreOptions } from '../src/index.js';

const stores: BamStore[] = [];

afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

describe('createDbStore', () => {
  it('throws when no postgresUrl is supplied', async () => {
    await expect(createDbStore({})).rejects.toThrow(/postgresUrl/);
  });

  it('throws on empty postgresUrl', async () => {
    await expect(createDbStore({ postgresUrl: '' })).rejects.toThrow(/postgresUrl/);
  });

  it('compile-time: `sqlitePath` is no longer assignable to DbStoreOptions', () => {
    // The previous shape supported `{ sqlitePath: string }`; the type now
    // rejects it. `@ts-expect-error` is the load-bearing assertion — if
    // `sqlitePath` ever becomes a known key again, the directive itself
    // fails the build because the next line stops being an error.
    const opts: DbStoreOptions = {
      postgresUrl: 'postgres://example/db',
      // @ts-expect-error sqlitePath is not part of DbStoreOptions
      sqlitePath: ':memory:',
    };
    expect(opts.postgresUrl).toBe('postgres://example/db');
  });
});
