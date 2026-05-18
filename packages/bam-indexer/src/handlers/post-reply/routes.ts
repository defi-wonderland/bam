/**
 * `post-reply` handler HTTP routes. All `GET`, all read from the
 * configured `<schema>.posts` table, all return server-shaped JSON
 * (no FE assumptions).
 *
 * `buildPostReplyRoutes` templates the routes and SQL on the
 * factory-supplied `schema` (SQL FROM clause) and `routePrefix`
 * (URL path prefix). bam-twitter's instance passes
 * `{ schema: 'twitter', routePrefix: '/twitter' }`; a future app
 * picks its own pair.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PoolClient } from 'pg';

import type { BoundHandlerRoute } from '../../framework/handler.js';
import { quoteIdent } from '../../framework/sql.js';

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

interface PostReplyPost {
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

function mapRow(r: PostRow): PostReplyPost {
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

export interface BuildPostReplyRoutesOptions {
  /** SQL schema that owns the `posts` table for this handler. */
  schema: string;
  /** URL path prefix the routes mount under (must start with `/`, no trailing slash). */
  routePrefix: string;
}

export function buildPostReplyRoutes(
  opts: BuildPostReplyRoutesOptions,
): BoundHandlerRoute[] {
  const { schema, routePrefix } = opts;
  const s = quoteIdent(schema);
  const POST_BY_ID_PREFIX = `${routePrefix}/posts/`;
  const PROFILE_PREFIX = `${routePrefix}/profile/`;

  /**
   * GET <routePrefix>/posts — top-level posts (`kind=0`), optionally
   * filtered by `?sender=`, optionally bounded by `?since=` (block
   * number), ordered newest-first by chain coord.
   */
  const postsHandler = async (
    req: IncomingMessage,
    res: ServerResponse,
    db: PoolClient,
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
        FROM ${s}.posts
       WHERE ${where.join(' AND ')}
       ORDER BY block_number DESC, tx_index DESC, message_index_within_batch DESC
       LIMIT $${params.length}`;
    const result = await db.query<PostRow>(sql, params);
    jsonResponse(res, 200, { posts: result.rows.map(mapRow) });
  };

  /**
   * GET <routePrefix>/posts/:messageId — single post lookup. Returns
   * 404 when the row hasn't been projected (either malformed, missing,
   * or reorged out).
   */
  const postByIdHandler = async (
    req: IncomingMessage,
    res: ServerResponse,
    db: PoolClient,
  ): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (!url.pathname.startsWith(POST_BY_ID_PREFIX)) return badRequest(res, 'path');
    const id = url.pathname.slice(POST_BY_ID_PREFIX.length);
    if (!HEX_BYTES32_RE.test(id)) return badRequest(res, 'messageId');
    const result = await db.query<PostRow>(
      `SELECT message_id, message_hash, sender, nonce, kind, timestamp, content,
              parent_message_hash, batch_ref, block_number, tx_index,
              message_index_within_batch, sender_ens
         FROM ${s}.posts
        WHERE message_id = $1`,
      [id.toLowerCase()],
    );
    if (result.rowCount === 0) return notFound(res);
    jsonResponse(res, 200, { post: mapRow(result.rows[0]) });
  };

  /**
   * GET <routePrefix>/replies?parentMessageHash=… — every reply under
   * a given parent. Indexer-side filter: orphan replies (parent not
   * projected yet) are not promoted here — the route returns the rows
   * that point at the given parent_message_hash, full stop.
   */
  const repliesHandler = async (
    req: IncomingMessage,
    res: ServerResponse,
    db: PoolClient,
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
         FROM ${s}.posts
        WHERE kind = 1 AND parent_message_hash = $1
        ORDER BY timestamp ASC, block_number ASC, tx_index ASC, message_index_within_batch ASC
        LIMIT $2`,
      [parent.toLowerCase(), limit],
    );
    jsonResponse(res, 200, { replies: result.rows.map(mapRow) });
  };

  /**
   * GET <routePrefix>/profile/:sender — denormalized handle (ENS) + a
   * window of the sender's most recent posts. The ENS field is null
   * when the sender has no primary name set (or when the indexer's
   * RPC is unreachable — see `enrichers/ens.ts`).
   */
  const profileHandler = async (
    req: IncomingMessage,
    res: ServerResponse,
    db: PoolClient,
  ): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (!url.pathname.startsWith(PROFILE_PREFIX)) return badRequest(res, 'path');
    const sender = url.pathname.slice(PROFILE_PREFIX.length);
    if (!HEX_ADDRESS_RE.test(sender)) return badRequest(res, 'sender');
    const limit = parseLimit(url.searchParams.get('limit'));
    if (limit === null) return badRequest(res, 'limit');
    const lower = sender.toLowerCase();
    const result = await db.query<PostRow>(
      `SELECT message_id, message_hash, sender, nonce, kind, timestamp, content,
              parent_message_hash, batch_ref, block_number, tx_index,
              message_index_within_batch, sender_ens
         FROM ${s}.posts
        WHERE sender = $1
        ORDER BY block_number DESC, tx_index DESC, message_index_within_batch DESC
        LIMIT $2`,
      [lower, limit],
    );
    const posts = result.rows.map(mapRow);
    const ens = posts.find((p) => p.sender_ens !== null)?.sender_ens ?? null;
    jsonResponse(res, 200, { ens, posts });
  };

  return [
    { method: 'GET', path: `${routePrefix}/posts`, handler: postsHandler },
    { method: 'GET', path: `${routePrefix}/posts/:messageId`, handler: postByIdHandler },
    { method: 'GET', path: `${routePrefix}/replies`, handler: repliesHandler },
    { method: 'GET', path: `${routePrefix}/profile/:sender`, handler: profileHandler },
  ];
}
