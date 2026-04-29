import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
} from 'drizzle-orm/pg-core';

// `Buffer` only exists in Node. The browser entrypoint pulls this
// module via `bam-store/browser`, so any unguarded `Buffer.from` here
// would `ReferenceError` at module-eval time in a real browser.
// node-postgres accepts `Uint8Array` directly for bytea params and
// PGLite's browser build returns `Uint8Array` from reads — we keep
// both ends of the wire as `Uint8Array` and only upgrade to `Buffer`
// when the host environment provides it.
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return 'bytea';
  },
  toDriver(value: Uint8Array): Uint8Array {
    return typeof Buffer !== 'undefined' ? Buffer.from(value) : value;
  },
  fromDriver(value: Uint8Array): Uint8Array {
    // node-postgres returns Buffer (a Uint8Array subclass); PGLite
    // returns a plain Uint8Array. Normalise to a non-Buffer view so
    // callers don't accidentally rely on Buffer-only methods.
    return value instanceof Uint8Array && value.constructor === Uint8Array
      ? value
      : new Uint8Array(value);
  },
});

export const bamStoreSchema = pgTable(
  'bam_store_schema',
  {
    id: integer('id').notNull().primaryKey(),
    version: integer('version').notNull(),
  },
  (t) => ({
    singleton: check('bam_store_schema_singleton', sql`${t.id} = 1`),
  })
);

export const messages = pgTable(
  'messages',
  {
    author: text('author').notNull(),
    nonce: text('nonce').notNull(),
    contentTag: text('content_tag').notNull(),
    contents: bytea('contents').notNull(),
    signature: bytea('signature').notNull(),
    messageHash: text('message_hash').notNull(),
    messageId: text('message_id'),
    status: text('status').notNull(),
    batchRef: text('batch_ref'),
    ingestedAt: bigint('ingested_at', { mode: 'number' }),
    ingestSeq: bigint('ingest_seq', { mode: 'number' }),
    blockNumber: bigint('block_number', { mode: 'number' }),
    txIndex: bigint('tx_index', { mode: 'number' }),
    messageIndexWithinBatch: bigint('message_index_within_batch', { mode: 'number' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.author, t.nonce] }),
    tagStatusSeq: index('idx_messages_tag_status_seq').on(
      t.contentTag,
      t.status,
      t.ingestSeq
    ),
    batchRef: index('idx_messages_batch_ref').on(t.batchRef),
    chainCoord: index('idx_messages_chain_coord').on(
      t.blockNumber,
      t.txIndex,
      t.messageIndexWithinBatch
    ),
    messageId: index('idx_messages_message_id').on(t.messageId),
    messageHash: index('idx_messages_message_hash').on(t.messageHash),
  })
);

export const batches = pgTable(
  'batches',
  {
    txHash: text('tx_hash').primaryKey(),
    chainId: bigint('chain_id', { mode: 'number' }).notNull(),
    contentTag: text('content_tag').notNull(),
    blobVersionedHash: text('blob_versioned_hash').notNull(),
    batchContentHash: text('batch_content_hash').notNull(),
    blockNumber: bigint('block_number', { mode: 'number' }),
    txIndex: bigint('tx_index', { mode: 'number' }),
    status: text('status').notNull(),
    replacedByTxHash: text('replaced_by_tx_hash'),
    submittedAt: bigint('submitted_at', { mode: 'number' }),
    invalidatedAt: bigint('invalidated_at', { mode: 'number' }),
    messageSnapshot: text('message_snapshot').notNull().default('[]'),
    submitter: text('submitter'),
    l1IncludedAtUnixSec: bigint('l1_included_at_unix_sec', { mode: 'number' }),
  },
  (t) => ({
    tagBlock: index('idx_batches_tag_block').on(t.contentTag, t.blockNumber),
    status: index('idx_batches_status').on(t.status),
  })
);

export const tagSeq = pgTable('tag_seq', {
  contentTag: text('content_tag').primaryKey(),
  lastSeq: bigint('last_seq', { mode: 'number' }).notNull(),
});

export const nonces = pgTable('nonces', {
  sender: text('sender').primaryKey(),
  lastNonce: text('last_nonce').notNull(),
  lastMessageHash: text('last_message_hash').notNull(),
});

export const readerCursor = pgTable('reader_cursor', {
  chainId: bigint('chain_id', { mode: 'number' }).primaryKey(),
  lastBlockNumber: bigint('last_block_number', { mode: 'number' }).notNull(),
  lastTxIndex: bigint('last_tx_index', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});
