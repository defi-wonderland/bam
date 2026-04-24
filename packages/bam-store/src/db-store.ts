import type { BamStore } from './types.js';
import { PostgresBamStore } from './postgres.js';
import { SqliteBamStore } from './sqlite.js';

export interface DbStoreOptions {
  /** Path for SQLite ("./poster.db", ":memory:", etc). Used when `postgresUrl` is absent. */
  sqlitePath?: string;
  /** Connection string. When present, selects the Postgres adapter. */
  postgresUrl?: string;
}

/**
 * Selects the DB adapter at startup: POSTGRES_URL wins; otherwise
 * SQLite.
 */
export function createDbStore(options: DbStoreOptions): BamStore {
  const pgUrl = options.postgresUrl ?? process.env.POSTGRES_URL;
  if (pgUrl && pgUrl.length > 0) {
    return new PostgresBamStore(pgUrl);
  }
  const path = options.sqlitePath ?? process.env.POSTER_SQLITE_PATH ?? './poster.db';
  return new SqliteBamStore(path);
}
