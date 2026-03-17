import Database from 'better-sqlite3';
import path from 'node:path';
import type { DbMessage, DbBlobble } from './types';

const DB_PATH = path.join(process.cwd(), 'blobble.db');

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id  TEXT NOT NULL UNIQUE,
        author      TEXT NOT NULL,
        timestamp   INTEGER NOT NULL,
        nonce       INTEGER NOT NULL,
        content     TEXT NOT NULL,
        signature   TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending',
        blobble_id  TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS blobbles (
        id            TEXT PRIMARY KEY,
        status        TEXT NOT NULL DEFAULT 'pending',
        tx_hash       TEXT,
        block_number  INTEGER,
        message_count INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }
  return db;
}

export function insertMessage(msg: {
  message_id: string;
  author: string;
  timestamp: number;
  nonce: number;
  content: string;
  signature: string;
}): DbMessage {
  const db = getDb();
  db.prepare(`
    INSERT INTO messages (message_id, author, timestamp, nonce, content, signature)
    VALUES (@message_id, @author, @timestamp, @nonce, @content, @signature)
  `).run(msg);
  return db
    .prepare('SELECT * FROM messages WHERE message_id = ?')
    .get(msg.message_id) as DbMessage;
}

export function getMessages(status?: string): DbMessage[] {
  const db = getDb();
  if (status) {
    return db
      .prepare('SELECT * FROM messages WHERE status = ? ORDER BY created_at DESC')
      .all(status) as DbMessage[];
  }
  return db
    .prepare('SELECT * FROM messages ORDER BY created_at DESC')
    .all() as DbMessage[];
}

export function getPendingMessages(): DbMessage[] {
  return getMessages('pending');
}

export function createBlobble(id: string, messageCount: number): DbBlobble {
  const db = getDb();
  db.prepare(
    "INSERT INTO blobbles (id, message_count) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET message_count = excluded.message_count, status = 'pending'"
  ).run(id, messageCount);
  return db.prepare('SELECT * FROM blobbles WHERE id = ?').get(id) as DbBlobble;
}

export function updateBlobbleStatus(
  id: string,
  status: 'pending' | 'confirmed' | 'failed',
  txHash?: string,
  blockNumber?: number
): void {
  const db = getDb();
  db.prepare(
    'UPDATE blobbles SET status = ?, tx_hash = ?, block_number = ? WHERE id = ?'
  ).run(status, txHash ?? null, blockNumber ?? null, id);
}

export function markMessagesPosted(messageIds: string[], blobbleId: string): void {
  const db = getDb();
  const stmt = db.prepare(
    'UPDATE messages SET status = ?, blobble_id = ? WHERE message_id = ?'
  );
  const tx = db.transaction(() => {
    for (const id of messageIds) {
      stmt.run('posted', blobbleId, id);
    }
  });
  tx();
}
