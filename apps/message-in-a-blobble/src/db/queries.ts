import { getDb } from './index';

export interface DbMessage {
  id: number;
  message_id: string;
  author: string;
  timestamp: number;
  nonce: number;
  content: string;
  signature: string;
  status: 'pending' | 'posted';
  blobble_id: string | null;
  created_at: string;
}

export interface DbBlobble {
  id: string;
  status: 'pending' | 'confirmed' | 'failed';
  tx_hash: string | null;
  block_number: number | null;
  message_count: number;
  created_at: string;
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
  const stmt = db.prepare(`
    INSERT INTO messages (message_id, author, timestamp, nonce, content, signature)
    VALUES (@message_id, @author, @timestamp, @nonce, @content, @signature)
  `);
  stmt.run(msg);
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
    'INSERT INTO blobbles (id, message_count) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET message_count = excluded.message_count, status = \'pending\''
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

