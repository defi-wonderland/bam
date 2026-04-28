/**
 * Hand-written DDL for the BAM storage substrate. Executed at adapter
 * construction time. Semantically equivalent to the Drizzle pg-core
 * schema in `./tables.ts`; that file is the typed-query source of
 * truth, this file is the bootstrap source of truth. The two are
 * kept in sync by hand. Future additive schema changes will revisit
 * this posture.
 *
 * Compatible with both real Postgres and PGLite.
 */

export const SQL_CREATE_DDL: readonly string[] = [
  // Singleton row by design — `id` PK with a CHECK forces the table to
  // hold at most one row regardless of how many writers race the seed
  // INSERT or what SCHEMA_VERSION values they carry. A multi-row
  // bam_store_schema would make the version read nondeterministic.
  `CREATE TABLE IF NOT EXISTS bam_store_schema (
    id            INTEGER NOT NULL PRIMARY KEY,
    version       INTEGER NOT NULL,
    CONSTRAINT bam_store_schema_singleton CHECK (id = 1)
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
    invalidated_at       BIGINT,
    message_snapshot     TEXT NOT NULL DEFAULT '[]'
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
