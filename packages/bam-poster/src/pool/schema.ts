/**
 * Durable schema for the Poster's pool + dedup index + submitted batches.
 * Created on first startup by the DB adapter; no migration library in v1.
 *
 * Nonces are stored as zero-padded TEXT(20) per `nonce-codec.ts`.
 */

export const SQL_CREATE_SQLITE = [
  `CREATE TABLE IF NOT EXISTS poster_pending (
    message_id    TEXT PRIMARY KEY,
    content_tag   TEXT NOT NULL,
    author        TEXT NOT NULL,
    nonce         TEXT NOT NULL,
    timestamp     INTEGER NOT NULL,
    content       BLOB NOT NULL,
    signature     BLOB NOT NULL,
    ingested_at   INTEGER NOT NULL,
    ingest_seq    INTEGER NOT NULL,
    UNIQUE (content_tag, ingest_seq)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_poster_pending_tag_seq
    ON poster_pending (content_tag, ingest_seq)`,
  `CREATE TABLE IF NOT EXISTS poster_nonces (
    author             TEXT PRIMARY KEY,
    last_nonce         TEXT NOT NULL,
    last_message_id    TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS poster_submitted_batches (
    tx_hash              TEXT PRIMARY KEY,
    content_tag          TEXT NOT NULL,
    blob_versioned_hash  TEXT NOT NULL,
    block_number         INTEGER,
    status               TEXT NOT NULL,
    replaced_by_tx_hash  TEXT,
    submitted_at         INTEGER NOT NULL,
    message_ids_json     TEXT NOT NULL,
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
  `CREATE TABLE IF NOT EXISTS poster_pending (
    message_id    TEXT PRIMARY KEY,
    content_tag   TEXT NOT NULL,
    author        TEXT NOT NULL,
    nonce         TEXT NOT NULL,
    timestamp     BIGINT NOT NULL,
    content       BYTEA NOT NULL,
    signature     BYTEA NOT NULL,
    ingested_at   BIGINT NOT NULL,
    ingest_seq    BIGINT NOT NULL,
    UNIQUE (content_tag, ingest_seq)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_poster_pending_tag_seq
    ON poster_pending (content_tag, ingest_seq)`,
  `CREATE TABLE IF NOT EXISTS poster_nonces (
    author             TEXT PRIMARY KEY,
    last_nonce         TEXT NOT NULL,
    last_message_id    TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS poster_submitted_batches (
    tx_hash              TEXT PRIMARY KEY,
    content_tag          TEXT NOT NULL,
    blob_versioned_hash  TEXT NOT NULL,
    block_number         BIGINT,
    status               TEXT NOT NULL,
    replaced_by_tx_hash  TEXT,
    submitted_at         BIGINT NOT NULL,
    message_ids_json     TEXT NOT NULL,
    messages_json        TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_poster_submitted_tag_block
    ON poster_submitted_batches (content_tag, block_number)`,
];
