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

export function getMessages(status?: string): DbMessage[] {
  const db = getDb();
  const query = status
    ? db.prepare(`
        SELECT m.*, b.tx_hash, b.block_number
        FROM messages m LEFT JOIN blobbles b ON m.blobble_id = b.id
        WHERE m.status = ? ORDER BY m.created_at DESC
      `)
    : db.prepare(`
        SELECT m.*, b.tx_hash, b.block_number
        FROM messages m LEFT JOIN blobbles b ON m.blobble_id = b.id
        ORDER BY m.created_at DESC
      `);
  return (status ? query.all(status) : query.all()) as DbMessage[];
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

export function getSyncedBlobbleTxHashes(): string[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT tx_hash FROM blobbles WHERE tx_hash IS NOT NULL AND message_count > 0")
    .all() as { tx_hash: string }[];
  return rows.map((r) => r.tx_hash);
}

export function insertSyncedMessage(msg: {
  message_id: string;
  author: string;
  timestamp: number;
  nonce: number;
  content: string;
  blobble_id: string;
}): void {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO messages (message_id, author, timestamp, nonce, content, signature, status, blobble_id)
    VALUES (@message_id, @author, @timestamp, @nonce, @content, '', 'posted', @blobble_id)
  `).run(msg);
}
