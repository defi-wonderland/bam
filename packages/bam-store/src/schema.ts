/**
 * Durable schema for the Poster's pool + dedup index + submitted batches.
 * Created on first startup by the DB adapter; no migration library — a
 * schema-version guard in `startup/reconcile.ts` refuses DBs written
 * under an earlier version rather than auto-migrating.
 *
 * Nonces are stored as zero-padded TEXT(20) per `nonce-codec.ts`.
 */

export const SCHEMA_VERSION = 2;

export const SQL_CREATE_SQLITE = [
  `CREATE TABLE IF NOT EXISTS poster_schema (
    version       INTEGER PRIMARY KEY
  )`,
  `CREATE TABLE IF NOT EXISTS poster_pending (
    content_tag        TEXT NOT NULL,
    sender             TEXT NOT NULL,
    nonce              TEXT NOT NULL,
    contents           BLOB NOT NULL,
    signature          BLOB NOT NULL,
    message_hash       TEXT NOT NULL,
    ingested_at        INTEGER NOT NULL,
    ingest_seq         INTEGER NOT NULL,
    PRIMARY KEY (sender, nonce),
    UNIQUE (content_tag, ingest_seq)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_poster_pending_tag_seq
    ON poster_pending (content_tag, ingest_seq)`,
  `CREATE TABLE IF NOT EXISTS poster_tag_seq (
    content_tag   TEXT PRIMARY KEY,
    last_seq      INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS poster_nonces (
    sender             TEXT PRIMARY KEY,
    last_nonce         TEXT NOT NULL,
    last_message_hash  TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS poster_submitted_batches (
    tx_hash              TEXT PRIMARY KEY,
    content_tag          TEXT NOT NULL,
    blob_versioned_hash  TEXT NOT NULL,
    batch_content_hash   TEXT NOT NULL,
    block_number         INTEGER,
    status               TEXT NOT NULL,
    replaced_by_tx_hash  TEXT,
    submitted_at         INTEGER NOT NULL,
    invalidated_at       INTEGER,
    messages_json        TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_poster_submitted_tag_block
    ON poster_submitted_batches (content_tag, block_number)`,
];

/**
 * Postgres flavor — bytea for binary; text for hex / JSON. Same
 * semantic constraints as SQLite, different types.
 */
export const SQL_CREATE_POSTGRES = [
  `CREATE TABLE IF NOT EXISTS poster_schema (
    version       INTEGER PRIMARY KEY
  )`,
  `CREATE TABLE IF NOT EXISTS poster_pending (
    content_tag        TEXT NOT NULL,
    sender             TEXT NOT NULL,
    nonce              TEXT NOT NULL,
    contents           BYTEA NOT NULL,
    signature          BYTEA NOT NULL,
    message_hash       TEXT NOT NULL,
    ingested_at        BIGINT NOT NULL,
    ingest_seq         BIGINT NOT NULL,
    PRIMARY KEY (sender, nonce),
    UNIQUE (content_tag, ingest_seq)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_poster_pending_tag_seq
    ON poster_pending (content_tag, ingest_seq)`,
  `CREATE TABLE IF NOT EXISTS poster_tag_seq (
    content_tag   TEXT PRIMARY KEY,
    last_seq      BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS poster_nonces (
    sender             TEXT PRIMARY KEY,
    last_nonce         TEXT NOT NULL,
    last_message_hash  TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS poster_submitted_batches (
    tx_hash              TEXT PRIMARY KEY,
    content_tag          TEXT NOT NULL,
    blob_versioned_hash  TEXT NOT NULL,
    batch_content_hash   TEXT NOT NULL,
    block_number         BIGINT,
    status               TEXT NOT NULL,
    replaced_by_tx_hash  TEXT,
    submitted_at         BIGINT NOT NULL,
    invalidated_at       BIGINT,
    messages_json        TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_poster_submitted_tag_block
    ON poster_submitted_batches (content_tag, block_number)`,
];
