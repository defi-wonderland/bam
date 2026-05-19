/**
 * `post-reply` handler HTTP routes. All `GET`, all read from the
 * configured `<schema>.posts` table.
 *
 * `buildPostReplyRoutes` templates the routes and SQL on the
 * factory-supplied `schema`, `routePrefix`, and `handlerName`.
 * `handlerName` lets the routes look up the current `version_id`
 * from `indexer.cursor`; consumers can override with
 * `?version=<uuid>` to target a frozen generation.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PoolClient } from 'pg';

import type { BoundHandlerRoute } from '../../framework/handler.js';
import { quoteIdent } from '../../framework/sql.js';
import { INDEXER_SCHEMA, CURSOR_TABLE } from '../../framework/cursor.js';

const HEX_BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
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
}

interface VersionRow {
  version_id: string;
  handler_version: number;
  is_current: boolean;
  superseded_at: string | null;
  last_block_number: string;
  last_tx_index: string;
  last_msg_index: string;
  last_reorg_invalidated_at: string;
  updated_at: string;
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
  /** Handler name — used to find the current generation in `indexer.cursor`. */
  handlerName: string;
}

export function buildPostReplyRoutes(
  opts: BuildPostReplyRoutesOptions,
): BoundHandlerRoute[] {
  const { schema, routePrefix, handlerName } = opts;
  const s = quoteIdent(schema);
  const POST_BY_ID_PREFIX = `${routePrefix}/posts/`;
  const PROFILE_PREFIX = `${routePrefix}/profile/`;

  /**
   * Resolve the requested generation:
   * - `?version=<uuid>` → that specific row's version_id (validates
   *   the row exists for this handler).
   * - omitted → the current generation's version_id.
   * Returns `null` if `?version=` was supplied but invalid or
   * unknown — caller should `badRequest`.
   */
  const resolveVersionId = async (
    db: PoolClient,
    raw: string | null,
  ): Promise<string | null | 'missing-current'> => {
    if (raw !== null && raw !== '') {
      if (!UUID_RE.test(raw)) return null;
      const r = await db.query<{ version_id: string }>(
        `SELECT version_id FROM ${INDEXER_SCHEMA}.${CURSOR_TABLE}
          WHERE handler_name = $1 AND version_id = $2`,
        [handlerName, raw.toLowerCase()],
      );
      return r.rowCount === 0 ? null : r.rows[0].version_id;
    }
    const r = await db.query<{ version_id: string }>(
      `SELECT version_id FROM ${INDEXER_SCHEMA}.${CURSOR_TABLE}
        WHERE handler_name = $1 AND is_current`,
      [handlerName],
    );
    return r.rowCount === 0 ? 'missing-current' : r.rows[0].version_id;
  };

  /**
   * GET <routePrefix>/posts — top-level posts (`kind=0`), optionally
   * filtered by `?sender=`, optionally bounded by `?since=` (block
   * number), ordered newest-first by chain coord. Defaults to the
   * current version; override with `?version=<uuid>`.
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

    const versionId = await resolveVersionId(db, url.searchParams.get('version'));
    if (versionId === null) return badRequest(res, 'version');
    if (versionId === 'missing-current') return notFound(res);

    const where: string[] = ['kind = 0', 'version_id = $1'];
    const params: unknown[] = [versionId];
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
             message_index_within_batch
        FROM ${s}.posts
       WHERE ${where.join(' AND ')}
       ORDER BY block_number DESC, tx_index DESC, message_index_within_batch DESC
       LIMIT $${params.length}`;
    const result = await db.query<PostRow>(sql, params);
    jsonResponse(res, 200, { version_id: versionId, posts: result.rows.map(mapRow) });
  };

  /**
   * GET <routePrefix>/posts/:messageId — single post lookup in the
   * resolved generation. Returns 404 when the row hasn't been
   * projected (malformed, missing, reorged out, or in a different
   * generation).
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

    const versionId = await resolveVersionId(db, url.searchParams.get('version'));
    if (versionId === null) return badRequest(res, 'version');
    if (versionId === 'missing-current') return notFound(res);

    const result = await db.query<PostRow>(
      `SELECT message_id, message_hash, sender, nonce, kind, timestamp, content,
              parent_message_hash, batch_ref, block_number, tx_index,
              message_index_within_batch
         FROM ${s}.posts
        WHERE version_id = $1 AND message_id = $2`,
      [versionId, id.toLowerCase()],
    );
    if (result.rowCount === 0) return notFound(res);
    jsonResponse(res, 200, { version_id: versionId, post: mapRow(result.rows[0]) });
  };

  /**
   * GET <routePrefix>/replies?parentMessageHash=… — every reply
   * under a given parent in the resolved generation. Orphan replies
   * (parent not projected yet) are not promoted here — the route
   * returns rows that point at the given parent_message_hash, full
   * stop.
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

    const versionId = await resolveVersionId(db, url.searchParams.get('version'));
    if (versionId === null) return badRequest(res, 'version');
    if (versionId === 'missing-current') return notFound(res);

    const result = await db.query<PostRow>(
      `SELECT message_id, message_hash, sender, nonce, kind, timestamp, content,
              parent_message_hash, batch_ref, block_number, tx_index,
              message_index_within_batch
         FROM ${s}.posts
        WHERE version_id = $1 AND kind = 1 AND parent_message_hash = $2
        ORDER BY timestamp ASC, block_number ASC, tx_index ASC, message_index_within_batch ASC
        LIMIT $3`,
      [versionId, parent.toLowerCase(), limit],
    );
    jsonResponse(res, 200, { version_id: versionId, replies: result.rows.map(mapRow) });
  };

  /**
   * GET <routePrefix>/profile/:sender — a window of the sender's
   * most recent posts in the resolved generation. Identity
   * resolution (ENS, display names) is the consumer's
   * responsibility; the indexer ships the address.
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

    const versionId = await resolveVersionId(db, url.searchParams.get('version'));
    if (versionId === null) return badRequest(res, 'version');
    if (versionId === 'missing-current') return notFound(res);

    const lower = sender.toLowerCase();
    const result = await db.query<PostRow>(
      `SELECT message_id, message_hash, sender, nonce, kind, timestamp, content,
              parent_message_hash, batch_ref, block_number, tx_index,
              message_index_within_batch
         FROM ${s}.posts
        WHERE version_id = $1 AND sender = $2
        ORDER BY block_number DESC, tx_index DESC, message_index_within_batch DESC
        LIMIT $3`,
      [versionId, lower, limit],
    );
    jsonResponse(res, 200, { version_id: versionId, posts: result.rows.map(mapRow) });
  };

  /**
   * GET <routePrefix>/versions — list every generation for this
   * handler with its cursor state. Newest-first (current row first,
   * then frozen generations by their `updated_at` descending).
   */
  const versionsHandler = async (
    _req: IncomingMessage,
    res: ServerResponse,
    db: PoolClient,
  ): Promise<void> => {
    const result = await db.query<VersionRow>(
      `SELECT version_id, handler_version, is_current, superseded_at,
              last_block_number, last_tx_index, last_msg_index,
              last_reorg_invalidated_at, updated_at
         FROM ${INDEXER_SCHEMA}.${CURSOR_TABLE}
        WHERE handler_name = $1
        ORDER BY is_current DESC, updated_at DESC`,
      [handlerName],
    );
    const versions = result.rows.map((r) => ({
      version_id: r.version_id,
      handler_version: r.handler_version,
      is_current: r.is_current,
      superseded_at: r.superseded_at === null ? null : Number(r.superseded_at),
      last_block_number: Number(r.last_block_number),
      last_tx_index: Number(r.last_tx_index),
      last_msg_index: Number(r.last_msg_index),
      last_reorg_invalidated_at: Number(r.last_reorg_invalidated_at),
      updated_at: Number(r.updated_at),
    }));
    jsonResponse(res, 200, { versions });
  };

  return [
    { method: 'GET', path: `${routePrefix}/posts`, handler: postsHandler },
    { method: 'GET', path: `${routePrefix}/posts/:messageId`, handler: postByIdHandler },
    { method: 'GET', path: `${routePrefix}/replies`, handler: repliesHandler },
    { method: 'GET', path: `${routePrefix}/profile/:sender`, handler: profileHandler },
    { method: 'GET', path: `${routePrefix}/versions`, handler: versionsHandler },
  ];
}
