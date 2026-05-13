/**
 * Twitter indexer handler. Decodes via `bam-app-codecs/twitter` and
 * projects into `twitter.posts`. Reorg cascade is a single `DELETE
 * WHERE batch_ref = $1` per affected tx-hash — clean because the
 * row was always anchored to a single batch.
 */

import { decodeTwitterContents, type TwitterMessage } from 'bam-app-codecs/twitter';
import type { Bytes32 } from 'bam-sdk';
import type { PoolClient } from 'pg';

import type {
  EnrichmentRequest,
  IndexerHandler,
} from '../../framework/handler.js';
import { TWITTER_DDL, TWITTER_SCHEMA_NAME } from './schema.js';
import { twitterRoutes } from './routes.js';

/** keccak256(utf8("bam-twitter.v1")) — sync with apps/bam-twitter/src/lib/constants.ts. */
export const TWITTER_TAG =
  '0xf0fea94ffd2ae32ed878c57e3427bbffab46d333d09837bc640d952795090718' as Bytes32;

const ENRICHMENTS: EnrichmentRequest[] = [{ kind: 'ens', from: 'sender' }];

export const twitterHandler: IndexerHandler<TwitterMessage> = {
  contentTag: TWITTER_TAG,
  name: 'twitter',
  version: 1,
  schema: TWITTER_SCHEMA_NAME,

  async migrate(client: PoolClient): Promise<void> {
    for (const stmt of TWITTER_DDL) {
      await client.query(stmt);
    }
  },

  decode(contents: Uint8Array): TwitterMessage | null {
    try {
      return decodeTwitterContents(contents).app;
    } catch {
      return null;
    }
  },

  enrichments: ENRICHMENTS,

  async project(msg, decoded, enr, txn): Promise<void> {
    if (msg.messageId === null) {
      // Reader writes confirmed rows with `message_id` populated.
      // A null here would be a Reader bug — skip rather than insert
      // a row with no PK.
      throw new Error(
        `twitter.project: missing message_id for confirmed message (sender=${msg.sender}, nonce=${msg.nonce})`
      );
    }
    if (
      msg.batchRef === null ||
      msg.blockNumber === null ||
      msg.txIndex === null ||
      msg.messageIndexWithinBatch === null
    ) {
      throw new Error(
        `twitter.project: confirmed row missing chain coord for ${msg.messageId}`
      );
    }

    const kind = decoded.kind === 'post' ? 0 : 1;
    const parentMessageHash =
      decoded.kind === 'reply' ? decoded.parentMessageHash.toLowerCase() : null;

    await txn.query(
      `INSERT INTO ${TWITTER_SCHEMA_NAME}.posts
         (message_id, message_hash, sender, nonce, kind, timestamp, content,
          parent_message_hash, batch_ref, block_number, tx_index,
          message_index_within_batch, sender_ens)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (message_id) DO UPDATE SET
         message_hash               = EXCLUDED.message_hash,
         kind                       = EXCLUDED.kind,
         timestamp                  = EXCLUDED.timestamp,
         content                    = EXCLUDED.content,
         parent_message_hash        = EXCLUDED.parent_message_hash,
         batch_ref                  = EXCLUDED.batch_ref,
         block_number               = EXCLUDED.block_number,
         tx_index                   = EXCLUDED.tx_index,
         message_index_within_batch = EXCLUDED.message_index_within_batch,
         sender_ens                 = EXCLUDED.sender_ens`,
      [
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
        enr.ens ?? null,
      ]
    );
  },

  async onReorg(reorgedTxHash, _chainId, txn): Promise<void> {
    // Reader's `markReorged` flips `messages.status = 'reorged'` for
    // every row whose `batch_ref = reorgedTxHash`. Our row keys off
    // the same `batch_ref`, so a single DELETE evicts the cascade.
    await txn.query(
      `DELETE FROM ${TWITTER_SCHEMA_NAME}.posts WHERE batch_ref = $1`,
      [reorgedTxHash.toLowerCase()]
    );
  },

  routes: twitterRoutes,
};
