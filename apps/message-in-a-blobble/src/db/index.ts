import Database from 'better-sqlite3';
import path from 'node:path';

const DB_PATH = path.join(process.cwd(), 'blobble.db');

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
  }
  return db;
}

function migrate(db: Database.Database) {
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
