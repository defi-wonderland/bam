/**
 * Durable schema for the BAM storage substrate. Created on first
 * startup by the DB adapter; no migration library — the schema-version
 * guard in `startup/reconcile.ts` refuses DBs written under an earlier
 * version rather than auto-migrating.
 *
 * Nonces are stored as zero-padded TEXT(20) per `nonce-codec.ts`.
 */

export const SCHEMA_VERSION = 3;

export const SQL_CREATE_SQLITE = [
  `CREATE TABLE IF NOT EXISTS bam_store_schema (
    version       INTEGER PRIMARY KEY
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    author                      TEXT NOT NULL,
    nonce                       TEXT NOT NULL,
    content_tag                 TEXT NOT NULL,
    contents                    BLOB NOT NULL,
    signature                   BLOB NOT NULL,
    message_hash                TEXT NOT NULL,
    message_id                  TEXT,
    status                      TEXT NOT NULL,
    batch_ref                   TEXT,
    ingested_at                 INTEGER,
    ingest_seq                  INTEGER,
    block_number                INTEGER,
    tx_index                    INTEGER,
    message_index_within_batch  INTEGER,
    PRIMARY KEY (author, nonce)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_tag_status_seq
    ON messages (content_tag, status, ingest_seq)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_batch_ref
    ON messages (batch_ref)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_chain_coord
    ON messages (block_number, tx_index, message_index_within_batch)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_message_id
    ON messages (message_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_message_hash
    ON messages (message_hash)`,
  `CREATE TABLE IF NOT EXISTS batches (
    tx_hash              TEXT PRIMARY KEY,
    chain_id             INTEGER NOT NULL,
    content_tag          TEXT NOT NULL,
    blob_versioned_hash  TEXT NOT NULL,
    batch_content_hash   TEXT NOT NULL,
    block_number         INTEGER,
    tx_index             INTEGER,
    status               TEXT NOT NULL,
    replaced_by_tx_hash  TEXT,
    submitted_at         INTEGER,
    invalidated_at       INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_batches_tag_block
    ON batches (content_tag, block_number)`,
  `CREATE INDEX IF NOT EXISTS idx_batches_status
    ON batches (status)`,
  `CREATE TABLE IF NOT EXISTS tag_seq (
    content_tag   TEXT PRIMARY KEY,
    last_seq      INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS nonces (
    sender             TEXT PRIMARY KEY,
    last_nonce         TEXT NOT NULL,
    last_message_hash  TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS reader_cursor (
    chain_id           INTEGER PRIMARY KEY,
    last_block_number  INTEGER NOT NULL,
    last_tx_index      INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
  )`,
];

/**
 * Postgres flavor — bytea for binary; text for hex. Same semantic
 * constraints as SQLite, different types.
 */
export const SQL_CREATE_POSTGRES = [
  `CREATE TABLE IF NOT EXISTS bam_store_schema (
    version       INTEGER PRIMARY KEY
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    author                      TEXT NOT NULL,
    nonce                       TEXT NOT NULL,
    content_tag                 TEXT NOT NULL,
    contents                    BYTEA NOT NULL,
    signature                   BYTEA NOT NULL,
    message_hash                TEXT NOT NULL,
    message_id                  TEXT,
    status                      TEXT NOT NULL,
    batch_ref                   TEXT,
    ingested_at                 BIGINT,
    ingest_seq                  BIGINT,
    block_number                BIGINT,
    tx_index                    BIGINT,
    message_index_within_batch  BIGINT,
    PRIMARY KEY (author, nonce)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_tag_status_seq
    ON messages (content_tag, status, ingest_seq)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_batch_ref
    ON messages (batch_ref)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_chain_coord
    ON messages (block_number, tx_index, message_index_within_batch)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_message_id
    ON messages (message_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_message_hash
    ON messages (message_hash)`,
  `CREATE TABLE IF NOT EXISTS batches (
    tx_hash              TEXT PRIMARY KEY,
    chain_id             BIGINT NOT NULL,
    content_tag          TEXT NOT NULL,
    blob_versioned_hash  TEXT NOT NULL,
    batch_content_hash   TEXT NOT NULL,
    block_number         BIGINT,
    tx_index             BIGINT,
    status               TEXT NOT NULL,
    replaced_by_tx_hash  TEXT,
    submitted_at         BIGINT,
    invalidated_at       BIGINT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_batches_tag_block
    ON batches (content_tag, block_number)`,
  `CREATE INDEX IF NOT EXISTS idx_batches_status
    ON batches (status)`,
  `CREATE TABLE IF NOT EXISTS tag_seq (
    content_tag   TEXT PRIMARY KEY,
    last_seq      BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS nonces (
    sender             TEXT PRIMARY KEY,
    last_nonce         TEXT NOT NULL,
    last_message_hash  TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS reader_cursor (
    chain_id           BIGINT PRIMARY KEY,
    last_block_number  BIGINT NOT NULL,
    last_tx_index      BIGINT NOT NULL,
    updated_at         BIGINT NOT NULL
  )`,
];
