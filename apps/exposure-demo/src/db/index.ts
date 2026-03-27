import Database from 'better-sqlite3';
import path from 'node:path';
import type { DbMessage, DbBlob } from './types';

const DB_PATH = path.join(process.cwd(), 'exposure-demo.db');

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id     TEXT NOT NULL UNIQUE,
        author         TEXT NOT NULL,
        timestamp      INTEGER NOT NULL,
        nonce          INTEGER NOT NULL,
        content        TEXT NOT NULL,
        bls_signature  TEXT NOT NULL,
        status         TEXT NOT NULL DEFAULT 'pending',
        blob_id        TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS blobs (
        id              TEXT PRIMARY KEY,
        status          TEXT NOT NULL DEFAULT 'pending',
        tx_hash         TEXT,
        block_number    INTEGER,
        versioned_hash  TEXT,
        message_count   INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }
  return db;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Messages
// ═══════════════════════════════════════════════════════════════════════════════

export function insertMessage(msg: {
  message_id: string;
  author: string;
  timestamp: number;
  nonce: number;
  content: string;
  bls_signature: string;
}): DbMessage {
  const d = getDb();
  d.prepare(`
    INSERT INTO messages (message_id, author, timestamp, nonce, content, bls_signature)
    VALUES (@message_id, @author, @timestamp, @nonce, @content, @bls_signature)
  `).run(msg);
  return d
    .prepare('SELECT * FROM messages WHERE message_id = ?')
    .get(msg.message_id) as DbMessage;
}

export function getMessages(status?: string): DbMessage[] {
  const d = getDb();
  if (status) {
    return d
      .prepare(`
        SELECT m.*, b.tx_hash, b.block_number
        FROM messages m LEFT JOIN blobs b ON m.blob_id = b.id
        WHERE m.status = ? ORDER BY m.created_at DESC
      `)
      .all(status) as DbMessage[];
  }
  return d
    .prepare(`
      SELECT m.*, b.tx_hash, b.block_number
      FROM messages m LEFT JOIN blobs b ON m.blob_id = b.id
      ORDER BY m.created_at DESC
    `)
    .all() as DbMessage[];
}

export function getPendingMessages(): DbMessage[] {
  return getMessages('pending');
}

export function getMessageById(messageId: string): DbMessage | undefined {
  const d = getDb();
  return d
    .prepare('SELECT * FROM messages WHERE message_id = ?')
    .get(messageId) as DbMessage | undefined;
}

export function getMessagesByBlobId(blobId: string): DbMessage[] {
  const d = getDb();
  return d
    .prepare('SELECT * FROM messages WHERE blob_id = ? ORDER BY nonce ASC')
    .all(blobId) as DbMessage[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Blobs
// ═══════════════════════════════════════════════════════════════════════════════

export function createBlob(id: string, messageCount: number): DbBlob {
  const d = getDb();
  d.prepare(
    "INSERT INTO blobs (id, message_count) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET message_count = excluded.message_count, status = 'pending'"
  ).run(id, messageCount);
  return d.prepare('SELECT * FROM blobs WHERE id = ?').get(id) as DbBlob;
}

export function updateBlobStatus(
  id: string,
  status: 'pending' | 'confirmed' | 'failed',
  txHash?: string,
  blockNumber?: number,
  versionedHash?: string
): void {
  const d = getDb();
  d.prepare(
    'UPDATE blobs SET status = ?, tx_hash = ?, block_number = ?, versioned_hash = ? WHERE id = ?'
  ).run(status, txHash ?? null, blockNumber ?? null, versionedHash ?? null, id);
}

export function markMessagesPosted(messageIds: string[], blobId: string): void {
  const d = getDb();
  const stmt = d.prepare(
    'UPDATE messages SET status = ?, blob_id = ? WHERE message_id = ?'
  );
  const tx = d.transaction(() => {
    for (const id of messageIds) {
      stmt.run('posted', blobId, id);
    }
  });
  tx();
}

export function getLastConfirmedBlob(): DbBlob | null {
  const d = getDb();
  const row = d
    .prepare("SELECT * FROM blobs WHERE status = 'confirmed' ORDER BY created_at DESC LIMIT 1")
    .get();
  return (row as DbBlob) ?? null;
}

export function getNextNonce(author: string): number {
  const d = getDb();
  const row = d
    .prepare('SELECT MAX(nonce) as max_nonce FROM messages WHERE LOWER(author) = LOWER(?)')
    .get(author) as { max_nonce: number | null } | undefined;
  return (row?.max_nonce ?? -1) + 1;
}
