/**
 * `post-reply` indexer handler factory. Multiple apps can each
 * instantiate one of these — distinct `contentTag`, distinct SQL
 * schema, distinct route prefix — and the framework will register
 * them side-by-side. bam-twitter is the first consumer (see
 * `src/bin/bam-indexer.ts`).
 *
 * The handler decodes via `bam-sdk/post-reply` and projects into
 * `<opts.schema>.posts`. Reorg cascade is a single `DELETE WHERE
 * batch_ref = $1` per affected tx-hash — clean because every row is
 * anchored to exactly one batch.
 */

import {
  decodePostReplyContents,
  type PostReplyMessage,
} from 'bam-sdk/post-reply';
import type { Bytes32 } from 'bam-sdk';
import type { PoolClient } from 'pg';

import type { IndexerHandler } from '../../framework/handler.js';
import { quoteIdent } from '../../framework/sql.js';
import { postReplyDdl } from './schema.js';
import { buildPostReplyRoutes } from './routes.js';

export interface PostReplyHandlerOptions {
  /** `handler.name` — must be unique across the registry. */
  name: string;
  /** Per-app keccak256 content tag the Reader writes under. */
  contentTag: Bytes32;
  /** SQL schema for this handler's `posts` table. Must be unique. */
  schema: string;
  /** URL path prefix for the handler's routes. Defaults to `/${name}`. */
  routePrefix?: string;
  /** Schema version — bump to trigger destructive re-migrate on startup. */
  version?: number;
}

export function createPostReplyHandler(
  opts: PostReplyHandlerOptions,
): IndexerHandler<PostReplyMessage> {
  const { name, contentTag, schema } = opts;
  const s = quoteIdent(schema);
  const routePrefix = opts.routePrefix ?? `/${name}`;
  const version = opts.version ?? 1;
  const ddl = postReplyDdl(schema);
  const routes = buildPostReplyRoutes({ schema, routePrefix, handlerName: name });

  return {
    contentTag,
    name,
    version,
    schema,

    async migrate(client: PoolClient): Promise<void> {
      for (const stmt of ddl) {
        await client.query(stmt);
      }
    },

    decode(contents: Uint8Array): PostReplyMessage | null {
      try {
        return decodePostReplyContents(contents).app;
      } catch {
        return null;
      }
    },

    async project(msg, decoded, _enr, txn, versionId): Promise<void> {
      if (msg.messageId === null) {
        // Reader writes confirmed rows with `message_id` populated.
        // A null here would be a Reader bug — skip rather than insert
        // a row with no PK.
        throw new Error(
          `post-reply.project: missing message_id for confirmed message (sender=${msg.sender}, nonce=${msg.nonce})`,
        );
      }
      if (
        msg.batchRef === null ||
        msg.blockNumber === null ||
        msg.txIndex === null ||
        msg.messageIndexWithinBatch === null
      ) {
        throw new Error(
          `post-reply.project: confirmed row missing chain coord for ${msg.messageId}`,
        );
      }

      const kind = decoded.kind === 'post' ? 0 : 1;
      const parentMessageHash =
        decoded.kind === 'reply' ? decoded.parentMessageHash.toLowerCase() : null;

      await txn.query(
        `INSERT INTO ${s}.posts
           (version_id, message_id, message_hash, sender, nonce, kind, timestamp, content,
            parent_message_hash, batch_ref, block_number, tx_index,
            message_index_within_batch)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (version_id, message_id) DO UPDATE SET
           message_hash               = EXCLUDED.message_hash,
           kind                       = EXCLUDED.kind,
           timestamp                  = EXCLUDED.timestamp,
           content                    = EXCLUDED.content,
           parent_message_hash        = EXCLUDED.parent_message_hash,
           batch_ref                  = EXCLUDED.batch_ref,
           block_number               = EXCLUDED.block_number,
           tx_index                   = EXCLUDED.tx_index,
           message_index_within_batch = EXCLUDED.message_index_within_batch`,
        [
          versionId,
          msg.messageId.toLowerCase(),
          msg.messageHash.toLowerCase(),
          msg.sender.toLowerCase(),
          msg.nonce.toString(),
          kind,
          decoded.timestamp,
          decoded.content,
          parentMessageHash,
          msg.batchRef.toLowerCase(),
          msg.blockNumber,
          msg.txIndex,
          msg.messageIndexWithinBatch,
        ],
      );
    },

    async onReorg(reorgedTxHash, _chainId, txn): Promise<void> {
      // Reader's `markReorged` flips `messages.status = 'reorged'`
      // for every row whose `batch_ref = reorgedTxHash`. Deleting by
      // `batch_ref` alone cascades across every generation that
      // projected the reorged batch.
      await txn.query(
        `DELETE FROM ${s}.posts WHERE batch_ref = $1`,
        [reorgedTxHash.toLowerCase()],
      );
    },

    async deleteVersion(versionId, txn): Promise<void> {
      await txn.query(
        `DELETE FROM ${s}.posts WHERE version_id = $1`,
        [versionId],
      );
    },

    routes,
  };
}
