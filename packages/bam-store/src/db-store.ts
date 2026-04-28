import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { PostgresBamStore, type PostgresBamStoreInit } from './postgres.js';

export interface DbStoreOptions {
  /** Connection string for the Postgres adapter. */
  postgresUrl?: string;
}

/**
 * Adapter selector: returns a `PostgresBamStore` when `postgresUrl`
 * is set; throws otherwise. Reads no environment variables — the
 * caller (e.g. the Poster's CLI `parseEnv`) is responsible for
 * resolving the URL from its own configuration. This keeps `bam-store`
 * free of host-env side-effects so library consumers see only what
 * they pass in.
 *
 * Node-only: this module statically imports `pg`. Browser callers
 * use `createMemoryStore()` from the package index, which constructs
 * `PostgresBamStore` over a PGLite instance and never reaches `pg`.
 */
export async function createDbStore(options: DbStoreOptions): Promise<PostgresBamStore> {
  if (options.postgresUrl && options.postgresUrl.length > 0) {
    return createPostgresStoreFromUrl(options.postgresUrl);
  }
  throw new Error(
    'createDbStore: provide `postgresUrl`. ' +
      'For in-process use, call `createMemoryStore()` instead.'
  );
}

/**
 * Construct a `PostgresBamStore` over a `pg.Pool` opened from a
 * connection string. Node-only — the `pg` driver and
 * `drizzle-orm/node-postgres` are statically imported here so that
 * callers reachable from the browser entrypoint can avoid them.
 */
export async function createPostgresStoreFromUrl(
  connectionString: string
): Promise<PostgresBamStore> {
  const pool = new pg.Pool({ connectionString });
  const db = drizzlePg(pool);
  const init: PostgresBamStoreInit = {
    db: db as unknown as PostgresBamStoreInit['db'],
    cleanup: () => pool.end(),
  };
  try {
    return await PostgresBamStore.open(init);
  } catch (err) {
    // open() runs DDL synchronously; if it throws (connection refused,
    // permissions, schema-version-row insert) the pool's `end()` would
    // otherwise be unreachable because cleanup is only attached on the
    // returned store. End it here so failed bootstraps don't leak
    // sockets.
    await pool.end().catch(() => {});
    throw err;
  }
}
