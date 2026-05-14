/**
 * Twitter handler schema. One table — `twitter.posts`. Replies and
 * top-level posts share the same row shape; the `kind` column
 * discriminates and `parent_message_hash` is non-null on replies
 * only.
 *
 * Indexes match the read paths the handler's routes serve: a
 * profile lookup (by sender, newest-first), a thread lookup (by
 * parent_message_hash), and a recency feed (by timestamp).
 *
 * `batch_ref` carries the L1 transaction hash; the reorg path
 * deletes by `batch_ref` because that's the key `markReorged`
 * cascades through.
 */

export const TWITTER_SCHEMA_NAME = 'twitter';

export const TWITTER_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${TWITTER_SCHEMA_NAME}.posts (
    message_id                  text PRIMARY KEY,
    message_hash                text NOT NULL,
    sender                      text NOT NULL,
    nonce                       text NOT NULL,
    kind                        smallint NOT NULL CHECK (kind IN (0, 1)),
    timestamp                   bigint NOT NULL,
    content                     text NOT NULL,
    parent_message_hash         text NULL,
    batch_ref                   text NOT NULL,
    block_number                bigint NOT NULL,
    tx_index                    bigint NOT NULL,
    message_index_within_batch  bigint NOT NULL,
    sender_ens                  text NULL
  )`,
  `CREATE INDEX IF NOT EXISTS posts_by_sender
    ON ${TWITTER_SCHEMA_NAME}.posts (sender, block_number DESC, tx_index DESC)`,
  `CREATE INDEX IF NOT EXISTS posts_by_parent
    ON ${TWITTER_SCHEMA_NAME}.posts (parent_message_hash)
    WHERE parent_message_hash IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS posts_by_time
    ON ${TWITTER_SCHEMA_NAME}.posts (timestamp DESC)`,
  `CREATE INDEX IF NOT EXISTS posts_by_batch_ref
    ON ${TWITTER_SCHEMA_NAME}.posts (batch_ref)`,
  // ERC-8180 messageHash is the pre-batch identifier that
  // Twitter replies bind to (parent_message_hash). Indexing it
  // lets the messageHash → posts lookup serve the Composer's
  // optimistic "did my reply land?" check.
  `CREATE INDEX IF NOT EXISTS posts_by_message_hash
    ON ${TWITTER_SCHEMA_NAME}.posts (message_hash)`,
];
