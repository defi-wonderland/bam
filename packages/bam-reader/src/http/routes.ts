/**
 * HTTP route handlers for the Reader.
 *
 * The Reader's HTTP surface is read-only by design (gate G-5). Every
 * handler here is invoked by a `GET` entry in `ROUTES`. Auth is the
 * operator's responsibility (default bind is `127.0.0.1` per
 * red-team C-1).
 *
 * Validation happens at the route boundary: query-string and path-
 * parameter values are typed/clamped before they reach `bam-store`.
 * Underlying read errors surface as 500 with a flat
 * `{ error: 'internal_error' }` body — driver / DSN strings are
 * logged server-side, never echoed to clients.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Address, Bytes32 } from 'bam-sdk';
import type {
  BatchStatus,
  BatchesQuery,
  MessageStatus,
  MessagesQuery,
} from 'bam-store';

import type { Reader } from '../factory.js';

export interface RouteContext {
  reader: Reader;
}

export interface RouteCallExtras {
  url: URL;
  pathParam: string | null;
}

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  extras: RouteCallExtras
) => Promise<void>;

const HEX_BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MESSAGE_STATUSES: ReadonlySet<MessageStatus> = new Set([
  'pending',
  'submitted',
  'confirmed',
  'reorged',
]);
const BATCH_STATUSES: ReadonlySet<BatchStatus> = new Set([
  'pending_tx',
  'confirmed',
  'reorged',
]);
const LIMIT_MIN = 1;
const LIMIT_MAX = 1000;

function bytesToHex(bytes: Uint8Array): string {
  // Buffer view over the same memory (no copy); `MessageRow.contents`
  // can be up to a full Sepolia blob (~128 KB), so the per-byte
  // `padStart` loop showed up under load.
  return (
    '0x' +
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex')
  );
}

/**
 * JSON encoder shared by every read endpoint. `bigint` values stringify
 * to decimal; `Uint8Array` (typed-array bytea fields) render as
 * `0x`-prefixed hex. The `replacer` runs on every value during
 * traversal; `Buffer` is a `Uint8Array` subclass and matches
 * `instanceof Uint8Array`, so node-postgres's `Buffer` rows work too.
 */
function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify(body, (_k, v) => {
      if (typeof v === 'bigint') return v.toString();
      if (v instanceof Uint8Array) return bytesToHex(v);
      return v;
    })
  );
}

function badRequest(res: ServerResponse, reason: string): void {
  jsonResponse(res, 400, { error: 'bad_request', reason });
}

function notFound(res: ServerResponse): void {
  jsonResponse(res, 404, { error: 'not_found' });
}

function internalError(res: ServerResponse): void {
  jsonResponse(res, 500, { error: 'internal_error' });
}

function logHandlerError(route: string, err: unknown): void {
  const detail = err instanceof Error ? err.stack ?? err.message : String(err);
  // Underlying detail goes to stderr only; clients see `internal_error`.
  process.stderr.write(`[bam-reader] ${route} handler failed: ${detail}\n`);
}

interface ParsedListQuery {
  contentTag: Bytes32;
  status?: string;
  limit?: number;
  batchRef?: Bytes32;
  author?: Address;
}

function parseLimit(raw: string): number | { error: string } {
  if (!/^\d+$/.test(raw)) return { error: 'limit' };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < LIMIT_MIN || n > LIMIT_MAX) {
    return { error: 'limit' };
  }
  return n;
}

function parseListQuery(
  url: URL,
  validStatuses: ReadonlySet<string>,
  options?: { allowBatchRef?: boolean; allowAuthor?: boolean }
): ParsedListQuery | { error: string } {
  const contentTag = url.searchParams.get('contentTag');
  if (contentTag === null) return { error: 'contentTag' };
  if (!HEX_BYTES32_RE.test(contentTag)) return { error: 'contentTag' };

  const out: ParsedListQuery = { contentTag: contentTag as Bytes32 };

  const status = url.searchParams.get('status');
  if (status !== null) {
    if (!validStatuses.has(status)) return { error: 'status' };
    out.status = status;
  }

  const limitRaw = url.searchParams.get('limit');
  if (limitRaw !== null) {
    const parsed = parseLimit(limitRaw);
    if (typeof parsed !== 'number') return parsed;
    out.limit = parsed;
  }

  if (options?.allowBatchRef) {
    const batchRef = url.searchParams.get('batchRef');
    if (batchRef !== null) {
      if (!HEX_BYTES32_RE.test(batchRef)) return { error: 'batchRef' };
      out.batchRef = batchRef as Bytes32;
    }
  }

  if (options?.allowAuthor) {
    const author = url.searchParams.get('author');
    if (author !== null) {
      if (!HEX_ADDRESS_RE.test(author)) return { error: 'author' };
      // Stored lower-case in `bam-store`; the postgres adapter also
      // lowers `query.author`, but normalise here so the bytes that
      // hit the wire match the stored form (mixed-case input still
      // works either way).
      out.author = author.toLowerCase() as Address;
    }
  }

  return out;
}

export const healthHandler: Handler = async (_req, res, ctx) => {
  const snapshot = await ctx.reader.health();
  jsonResponse(res, 200, snapshot);
};

export const messagesHandler: Handler = async (_req, res, ctx, extras) => {
  const parsed = parseListQuery(extras.url, MESSAGE_STATUSES, {
    allowBatchRef: true,
    allowAuthor: true,
  });
  if ('error' in parsed) {
    badRequest(res, parsed.error);
    return;
  }
  const query: MessagesQuery = {
    contentTag: parsed.contentTag,
    ...(parsed.status !== undefined && { status: parsed.status as MessageStatus }),
    ...(parsed.limit !== undefined && { limit: parsed.limit }),
    ...(parsed.batchRef !== undefined && { batchRef: parsed.batchRef }),
    ...(parsed.author !== undefined && { author: parsed.author }),
  };
  try {
    const messages = await ctx.reader.listConfirmedMessages(query);
    jsonResponse(res, 200, { messages });
  } catch (err) {
    logHandlerError('GET /messages', err);
    internalError(res);
  }
};

export const batchesHandler: Handler = async (_req, res, ctx, extras) => {
  const parsed = parseListQuery(extras.url, BATCH_STATUSES);
  if ('error' in parsed) {
    badRequest(res, parsed.error);
    return;
  }
  const query: BatchesQuery = {
    contentTag: parsed.contentTag,
    ...(parsed.status !== undefined && { status: parsed.status as BatchStatus }),
    ...(parsed.limit !== undefined && { limit: parsed.limit }),
  };
  try {
    const batches = await ctx.reader.listBatches(query);
    jsonResponse(res, 200, { batches });
  } catch (err) {
    logHandlerError('GET /batches', err);
    internalError(res);
  }
};

export const batchByTxHashHandler: Handler = async (_req, res, ctx, extras) => {
  const txHash = extras.pathParam;
  if (txHash === null || !HEX_BYTES32_RE.test(txHash)) {
    badRequest(res, 'txHash');
    return;
  }
  try {
    const batch = await ctx.reader.getBatch(txHash as Bytes32);
    if (batch === null) {
      notFound(res);
      return;
    }
    jsonResponse(res, 200, { batch });
  } catch (err) {
    logHandlerError('GET /batches/:txHash', err);
    internalError(res);
  }
};
