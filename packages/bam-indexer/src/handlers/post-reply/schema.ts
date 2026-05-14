/**
 * DDL builder for the `post-reply` handler. One table — `<schema>.posts`
 * — that backs both top-level posts and one-level replies. The `kind`
 * column discriminates and `parent_message_hash` is non-null on replies
 * only.
 *
 * The schema name is supplied by the factory (`createPostReplyHandler`)
 * so multiple apps can each instantiate their own table in their own
 * schema. bam-twitter uses `twitter.posts`; a future app picks another
 * schema name.
 *
 * Indexes match the read paths the handler's routes serve: profile (by
 * sender, newest-first), thread (by parent_message_hash), recency feed
 * (by timestamp), reorg cascade (by batch_ref), and the optimistic
 * "did my reply land?" lookup (by message_hash).
 */

export function postReplyDdl(schema: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${schema}.posts (
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
      ON ${schema}.posts (sender, block_number DESC, tx_index DESC)`,
    `CREATE INDEX IF NOT EXISTS posts_by_parent
      ON ${schema}.posts (parent_message_hash)
      WHERE parent_message_hash IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS posts_by_time
      ON ${schema}.posts (timestamp DESC)`,
    `CREATE INDEX IF NOT EXISTS posts_by_batch_ref
      ON ${schema}.posts (batch_ref)`,
    // ERC-8180 messageHash is the pre-batch identifier that replies
    // bind to (parent_message_hash). Indexing it lets the
    // messageHash → posts lookup serve the Composer's optimistic
    // "did my reply land?" check.
    `CREATE INDEX IF NOT EXISTS posts_by_message_hash
      ON ${schema}.posts (message_hash)`,
  ];
}
