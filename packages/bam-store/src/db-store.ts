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
 * Adapter selector: pick Postgres when `postgresUrl` is set, SQLite
 * otherwise. Reads no environment variables — the caller (e.g. the
 * Poster's CLI `parseEnv`) is responsible for resolving the URL/path
 * from its own configuration. This keeps `bam-store` free of host-env
 * side-effects so library consumers see only what they pass in.
 */
export function createDbStore(options: DbStoreOptions): BamStore {
  if (options.postgresUrl && options.postgresUrl.length > 0) {
    return new PostgresBamStore(options.postgresUrl);
  }
  if (options.sqlitePath && options.sqlitePath.length > 0) {
    return new SqliteBamStore(options.sqlitePath);
  }
  throw new Error(
    'createDbStore: provide either `sqlitePath` or `postgresUrl`. ' +
      'No env-var fallbacks — resolve from your config and pass in.'
  );
}
