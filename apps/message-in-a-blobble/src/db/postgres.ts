import { sql } from '@vercel/postgres';
import type { DbMessage, DbBlobble } from './types';

let migrated = false;

async function ensureTables() {
  if (migrated) return;
  await sql`
    CREATE TABLE IF NOT EXISTS messages (
      id          SERIAL PRIMARY KEY,
      message_id  TEXT NOT NULL UNIQUE,
      author      TEXT NOT NULL,
      timestamp   INTEGER NOT NULL,
      nonce       INTEGER NOT NULL,
      content     TEXT NOT NULL,
      signature   TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      blobble_id  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS blobbles (
      id            TEXT PRIMARY KEY,
      status        TEXT NOT NULL DEFAULT 'pending',
      tx_hash       TEXT,
      block_number  INTEGER,
      message_count INTEGER NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  migrated = true;
}

export async function insertMessage(msg: {
  message_id: string;
  author: string;
  timestamp: number;
  nonce: number;
  content: string;
  signature: string;
}): Promise<DbMessage> {
  await ensureTables();
  const { rows } = await sql`
    INSERT INTO messages (message_id, author, timestamp, nonce, content, signature)
    VALUES (${msg.message_id}, ${msg.author}, ${msg.timestamp}, ${msg.nonce}, ${msg.content}, ${msg.signature})
    RETURNING *
  `;
  return rows[0] as DbMessage;
}

export async function getMessages(status?: string): Promise<DbMessage[]> {
  await ensureTables();
  if (status) {
    const { rows } = await sql`
      SELECT m.*, b.tx_hash, b.block_number
      FROM messages m LEFT JOIN blobbles b ON m.blobble_id = b.id
      WHERE m.status = ${status} ORDER BY m.created_at DESC
    `;
    return rows as DbMessage[];
  }
  const { rows } = await sql`
    SELECT m.*, b.tx_hash, b.block_number
    FROM messages m LEFT JOIN blobbles b ON m.blobble_id = b.id
    ORDER BY m.created_at DESC
  `;
  return rows as DbMessage[];
}

export async function getPendingMessages(): Promise<DbMessage[]> {
  return getMessages('pending');
}

export async function createBlobble(id: string, messageCount: number): Promise<DbBlobble> {
  await ensureTables();
  const { rows } = await sql`
    INSERT INTO blobbles (id, message_count) VALUES (${id}, ${messageCount})
    ON CONFLICT (id) DO UPDATE SET message_count = EXCLUDED.message_count, status = 'pending'
    RETURNING *
  `;
  return rows[0] as DbBlobble;
}

export async function updateBlobbleStatus(
  id: string,
  status: 'pending' | 'confirmed' | 'failed',
  txHash?: string,
  blockNumber?: number
): Promise<void> {
  await ensureTables();
  await sql`
    UPDATE blobbles SET status = ${status}, tx_hash = ${txHash ?? null}, block_number = ${blockNumber ?? null}
    WHERE id = ${id}
  `;
}

export async function getAllBlobbleTxHashes(): Promise<string[]> {
  await ensureTables();
  const { rows } = await sql`
    SELECT tx_hash FROM blobbles WHERE tx_hash IS NOT NULL
  `;
  return rows.map((r) => r.tx_hash as string);
}

export async function getLastConfirmedBlobble(): Promise<DbBlobble | null> {
  await ensureTables();
  const { rows } = await sql`
    SELECT * FROM blobbles WHERE status = 'confirmed' ORDER BY created_at DESC LIMIT 1
  `;
  return (rows[0] as DbBlobble) ?? null;
}

export async function insertSyncedMessage(msg: {
  message_id: string;
  author: string;
  timestamp: number;
  nonce: number;
  content: string;
  blobble_id: string;
}): Promise<void> {
  await ensureTables();
  await sql`
    INSERT INTO messages (message_id, author, timestamp, nonce, content, signature, status, blobble_id)
    VALUES (${msg.message_id}, ${msg.author}, ${msg.timestamp}, ${msg.nonce}, ${msg.content}, '', 'posted', ${msg.blobble_id})
    ON CONFLICT (message_id) DO NOTHING
  `;
}

export async function markMessagesPosted(messageIds: string[], blobbleId: string): Promise<void> {
  await ensureTables();
  for (const id of messageIds) {
    await sql`
      UPDATE messages SET status = 'posted', blobble_id = ${blobbleId} WHERE message_id = ${id}
    `;
  }
}
