-- Coprocessor service schema. Runs idempotently at service startup
-- alongside (but independent of) bam-store's own DDL. No SCHEMA_VERSION
-- coupling — same pattern as bam-indexer's `indexer.*` schema.

CREATE SCHEMA IF NOT EXISTS coprocessor;

-- Per-message validation rows. Filled by Job V (--execute, no proof).
CREATE TABLE IF NOT EXISTS coprocessor.validations (
  message_hash      BYTEA PRIMARY KEY,
  chain_id          BIGINT NOT NULL,
  versioned_hash    BYTEA NOT NULL,
  content_tag       BYTEA NOT NULL,
  start_fe          INTEGER NOT NULL,
  end_fe            INTEGER NOT NULL,
  block_number      BIGINT NOT NULL,
  tx_index          INTEGER NOT NULL,
  msg_index         INTEGER NOT NULL,
  sender            BYTEA NOT NULL,
  nonce             BIGINT NOT NULL,
  cycles            BIGINT NOT NULL,
  validated_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS validations_by_chain_coord
  ON coprocessor.validations(chain_id, block_number, tx_index, msg_index);
CREATE INDEX IF NOT EXISTS validations_by_validated_at
  ON coprocessor.validations(validated_at DESC, message_hash DESC);

-- Per-message Groth16 proofs.
CREATE TABLE IF NOT EXISTS coprocessor.proofs (
  message_hash      BYTEA PRIMARY KEY,
  chain_id          BIGINT NOT NULL,
  versioned_hash    BYTEA NOT NULL,
  content_tag       BYTEA NOT NULL,
  start_fe          INTEGER NOT NULL,
  end_fe            INTEGER NOT NULL,
  block_number      BIGINT NOT NULL,
  tx_index          INTEGER NOT NULL,
  msg_index         INTEGER NOT NULL,
  sender            BYTEA NOT NULL,
  nonce             BIGINT NOT NULL,
  cycles            BIGINT NOT NULL,
  proof_size        INTEGER NOT NULL,
  proof_bytes       BYTEA NOT NULL,
  public_values     BYTEA NOT NULL,
  request_id        BYTEA NOT NULL,
  tx_hash           BYTEA,
  proof_type        TEXT NOT NULL DEFAULT 'groth16',
  sp1_version       TEXT NOT NULL,
  proven_at         TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS proofs_by_chain_coord
  ON coprocessor.proofs(chain_id, block_number, tx_index, msg_index);
CREATE INDEX IF NOT EXISTS proofs_by_proven_at
  ON coprocessor.proofs(proven_at DESC, message_hash DESC);
CREATE INDEX IF NOT EXISTS proofs_by_versioned_hash
  ON coprocessor.proofs(versioned_hash);

-- One watermark per (job, chain_id). job ∈ {'validation','proof'}.
CREATE TABLE IF NOT EXISTS coprocessor.watermarks (
  job          TEXT NOT NULL,
  chain_id     BIGINT NOT NULL,
  block_number BIGINT NOT NULL DEFAULT 0,
  tx_index     INTEGER NOT NULL DEFAULT 0,
  msg_index    INTEGER NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (job, chain_id)
);

-- Crash-recovery hook for in-flight Groth16 requests.
CREATE TABLE IF NOT EXISTS coprocessor.proof_in_flight (
  request_id     BYTEA PRIMARY KEY,
  message_hash   BYTEA NOT NULL,
  chain_id       BIGINT NOT NULL,
  block_number   BIGINT NOT NULL,
  tx_index       INTEGER NOT NULL,
  msg_index      INTEGER NOT NULL,
  started_at     TIMESTAMPTZ NOT NULL
);

-- VK material captured on first proof; served from /proof/vk.
CREATE TABLE IF NOT EXISTS coprocessor.vk_cache (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  vk_hash     TEXT NOT NULL,
  groth16_vk  BYTEA NOT NULL,
  sp1_version TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL
);
