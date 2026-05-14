/**
 * Twitter handler HTTP routes. All `GET`, all read from
 * `twitter.posts`, all return server-shaped JSON (no FE assumptions).
 *
 * The framework mounts these under `/twitter` so the table here is
 * already the prefix the client sees. Path-param routes use the same
 * `:name` convention as `bam-reader`'s server.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PoolClient } from 'pg';

import type { BoundHandlerRoute } from '../../framework/handler.js';

const HEX_BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const LIMIT_MAX = 200;
const LIMIT_DEFAULT = 50;

interface PostRow {
  message_id: string;
  message_hash: string;
  sender: string;
  nonce: string;
  kind: number;
  timestamp: string;
  content: string;
  parent_message_hash: string | null;
  batch_ref: string;
  block_number: string;
  tx_index: string;
  message_index_within_batch: string;
  sender_ens: string | null;
}

interface TwitterPost {
  message_id: string;
  message_hash: string;
  sender: string;
  nonce: string;
  kind: 'post' | 'reply';
  timestamp: number;
  content: string;
  parent_message_hash: string | null;
  batch_ref: string;
  block_number: number;
  tx_index: number;
  message_index_within_batch: number;
  sender_ens: string | null;
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function badRequest(res: ServerResponse, field: string): void {
  jsonResponse(res, 400, { error: 'bad_request', reason: field });
}

function notFound(res: ServerResponse): void {
  jsonResponse(res, 404, { error: 'not_found' });
}

function mapRow(r: PostRow): TwitterPost {
  return {
    message_id: r.message_id,
    message_hash: r.message_hash,
    sender: r.sender,
    nonce: r.nonce,
    kind: r.kind === 0 ? 'post' : 'reply',
    timestamp: Number(r.timestamp),
    content: r.content,
    parent_message_hash: r.parent_message_hash,
    batch_ref: r.batch_ref,
    block_number: Number(r.block_number),
    tx_index: Number(r.tx_index),
    message_index_within_batch: Number(r.message_index_within_batch),
    sender_ens: r.sender_ens,
  };
}

function parseLimit(raw: string | null): number | null {
  if (raw === null || raw === '') return LIMIT_DEFAULT;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > LIMIT_MAX) return null;
  return n;
}

/**
 * GET /twitter/posts — top-level posts (`kind=post`), optionally
 * filtered by `?sender=`, optionally bounded by `?since=` (block
 * number), default ordered newest-first by chain coord.
 */
const postsHandler = async (
  req: IncomingMessage,
  res: ServerResponse,
  db: PoolClient
): Promise<void> => {
  const url = new URL(req.url ?? '/', 'http://local');
  const sender = url.searchParams.get('sender');
  const since = url.searchParams.get('since');
  const limit = parseLimit(url.searchParams.get('limit'));
  if (limit === null) return badRequest(res, 'limit');
  if (sender !== null && !HEX_ADDRESS_RE.test(sender)) return badRequest(res, 'sender');
  if (since !== null && !/^\d+$/.test(since)) return badRequest(res, 'since');

  const where: string[] = ['kind = 0'];
  const params: unknown[] = [];
  if (sender !== null) {
    params.push(sender.toLowerCase());
    where.push(`sender = $${params.length}`);
  }
  if (since !== null) {
    params.push(Number(since));
    where.push(`block_number >= $${params.length}`);
  }
  params.push(limit);
  const sql = `
    SELECT message_id, message_hash, sender, nonce, kind, timestamp, content,
           parent_message_hash, batch_ref, block_number, tx_index,
           message_index_within_batch, sender_ens
      FROM twitter.posts
     WHERE ${where.join(' AND ')}
     ORDER BY block_number DESC, tx_index DESC, message_index_within_batch DESC
     LIMIT $${params.length}`;
  const result = await db.query<PostRow>(sql, params);
  jsonResponse(res, 200, { posts: result.rows.map(mapRow) });
};

/**
 * GET /twitter/posts/:messageId — single post lookup. Returns
 * 404 when the row hasn't been projected (either malformed,
 * missing, or reorged out).
 */
const postByIdHandler = async (
  req: IncomingMessage,
  res: ServerResponse,
  db: PoolClient
): Promise<void> => {
  const url = new URL(req.url ?? '/', 'http://local');
  // The framework's router strips the prefix `/twitter` and leaves
  // the remaining pathname here; for `/twitter/posts/:messageId`
  // the request URL still arrives as `/twitter/posts/<id>` because
  // `BoundHandlerRoute.path` is matched against the full pathname.
  // We trim the known prefix.
  const PREFIX = '/twitter/posts/';
  if (!url.pathname.startsWith(PREFIX)) return badRequest(res, 'path');
  const id = url.pathname.slice(PREFIX.length);
  if (!HEX_BYTES32_RE.test(id)) return badRequest(res, 'messageId');
  const result = await db.query<PostRow>(
    `SELECT message_id, message_hash, sender, nonce, kind, timestamp, content,
            parent_message_hash, batch_ref, block_number, tx_index,
            message_index_within_batch, sender_ens
       FROM twitter.posts
      WHERE message_id = $1`,
    [id.toLowerCase()]
  );
  if (result.rowCount === 0) return notFound(res);
  jsonResponse(res, 200, { post: mapRow(result.rows[0]) });
};

/**
 * GET /twitter/replies?parentMessageHash=… — every reply under a
 * given parent. Indexer-side filter: orphan replies (parent not
 * projected yet) are not promoted here — the route returns the rows
 * that point at the given parent_message_hash, full stop.
 */
const repliesHandler = async (
  req: IncomingMessage,
  res: ServerResponse,
  db: PoolClient
): Promise<void> => {
  const url = new URL(req.url ?? '/', 'http://local');
  const parent = url.searchParams.get('parentMessageHash');
  const limit = parseLimit(url.searchParams.get('limit'));
  if (limit === null) return badRequest(res, 'limit');
  if (parent === null || !HEX_BYTES32_RE.test(parent)) return badRequest(res, 'parentMessageHash');
  const result = await db.query<PostRow>(
    `SELECT message_id, message_hash, sender, nonce, kind, timestamp, content,
            parent_message_hash, batch_ref, block_number, tx_index,
            message_index_within_batch, sender_ens
       FROM twitter.posts
      WHERE kind = 1 AND parent_message_hash = $1
      ORDER BY timestamp ASC, block_number ASC, tx_index ASC, message_index_within_batch ASC
      LIMIT $2`,
    [parent.toLowerCase(), limit]
  );
  jsonResponse(res, 200, { replies: result.rows.map(mapRow) });
};

/**
 * GET /twitter/profile/:sender — denormalized handle (ENS) + a
 * window of the sender's most recent posts. The ENS field is null
 * when the sender has no primary name set (or when the indexer's
 * RPC is unreachable — see `enrichers/ens.ts`).
 */
const profileHandler = async (
  req: IncomingMessage,
  res: ServerResponse,
  db: PoolClient
): Promise<void> => {
  const url = new URL(req.url ?? '/', 'http://local');
  const PREFIX = '/twitter/profile/';
  if (!url.pathname.startsWith(PREFIX)) return badRequest(res, 'path');
  const sender = url.pathname.slice(PREFIX.length);
  if (!HEX_ADDRESS_RE.test(sender)) return badRequest(res, 'sender');
  const limit = parseLimit(url.searchParams.get('limit'));
  if (limit === null) return badRequest(res, 'limit');
  const lower = sender.toLowerCase();
  const result = await db.query<PostRow>(
    `SELECT message_id, message_hash, sender, nonce, kind, timestamp, content,
            parent_message_hash, batch_ref, block_number, tx_index,
            message_index_within_batch, sender_ens
       FROM twitter.posts
      WHERE sender = $1
      ORDER BY block_number DESC, tx_index DESC, message_index_within_batch DESC
      LIMIT $2`,
    [lower, limit]
  );
  const posts = result.rows.map(mapRow);
  const ens = posts.find((p) => p.sender_ens !== null)?.sender_ens ?? null;
  jsonResponse(res, 200, { ens, posts });
};

export const twitterRoutes: BoundHandlerRoute[] = [
  { method: 'GET', path: '/twitter/posts', handler: postsHandler },
  { method: 'GET', path: '/twitter/posts/:messageId', handler: postByIdHandler },
  { method: 'GET', path: '/twitter/replies', handler: repliesHandler },
  { method: 'GET', path: '/twitter/profile/:sender', handler: profileHandler },
];
