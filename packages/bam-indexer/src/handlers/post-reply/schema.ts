/**
 * DDL builder for the `post-reply` handler. One table per
 * configured schema (`<schema>.posts`) backs every generation: each
 * row carries a `version_id` that identifies which handler
 * generation projected it, and the PK is `(version_id, message_id)`
 * so two generations can independently re-project the same message.
 *
 * `batch_ref` is the L1 transaction hash; reorg cascades DELETE by
 * `batch_ref` alone so all generations that projected the reorged
 * batch are evicted in a single statement.
 *
 * Indexes match the read paths the handler's routes serve. Every
 * index leads with `version_id` so per-version reads stay
 * index-only.
 */

import { quoteIdent } from '../../framework/sql.js';

export function postReplyDdl(schema: string): string[] {
  const s = quoteIdent(schema);
  return [
    `CREATE TABLE IF NOT EXISTS ${s}.posts (
      version_id                  uuid NOT NULL,
      message_id                  text NOT NULL,
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
      PRIMARY KEY (version_id, message_id),
      -- post (kind=0) ⇒ no parent; reply (kind=1) ⇒ parent is set.
      CONSTRAINT posts_kind_parent_consistent CHECK (
        (kind = 0 AND parent_message_hash IS NULL)
        OR (kind = 1 AND parent_message_hash IS NOT NULL)
      )
    )`,
    `CREATE INDEX IF NOT EXISTS posts_by_sender
      ON ${s}.posts (version_id, sender, block_number DESC, tx_index DESC)`,
    `CREATE INDEX IF NOT EXISTS posts_by_parent
      ON ${s}.posts (version_id, parent_message_hash)
      WHERE parent_message_hash IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS posts_by_time
      ON ${s}.posts (version_id, timestamp DESC)`,
    `CREATE INDEX IF NOT EXISTS posts_by_batch_ref
      ON ${s}.posts (batch_ref)`,
    // ERC-8180 messageHash is the pre-batch identifier that replies
    // bind to (parent_message_hash). Cross-version index — the
    // Composer's optimistic "did my reply land?" lookup hits any
    // generation that has the row without a version filter.
    `CREATE INDEX IF NOT EXISTS posts_by_message_hash
      ON ${s}.posts (message_hash)`,
  ];
}
