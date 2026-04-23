import type { IncomingMessage, ServerResponse } from 'node:http';

import { bytesToHex } from 'bam-sdk';

import type { Poster } from '../types.js';
import { rejectionToStatus } from './error-map.js';

export interface RouteContext {
  poster: Poster;
  maxMessageSizeBytes: number;
}

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext
) => Promise<void>;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, (_, v) =>
    typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? bytesToHex(v) : v
  );
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(json);
}

/**
 * FU-4: read the request body up to `cap` bytes, and short-circuit
 * with a 413 + socket destroy as soon as the cap is exceeded. We
 * don't wait for `end` — an attacker streaming gigabytes would
 * otherwise tie up the socket even though we already know we'll
 * reject. Returns `'too_large'` (after responding + destroying) or
 * the full buffer once the client's body has completed.
 *
 * Qodo review: also listens for `aborted` + `close` so a client
 * disconnect mid-upload resolves the promise immediately rather
 * than leaving the handler hanging (slowloris-ish concern).
 */
async function readBodyBounded(
  req: IncomingMessage,
  res: ServerResponse,
  cap: number
): Promise<Buffer | 'too_large' | 'aborted'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = (): void => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
      req.removeListener('close', onClose);
    };
    const onData = (c: Buffer): void => {
      if (settled) return;
      total += c.length;
      if (total > cap) {
        settled = true;
        cleanup();
        // Respond with 413 immediately + sever the socket so the
        // peer's upload stops rather than draining to completion.
        if (!res.headersSent) {
          res.statusCode = 413;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({ accepted: false, reason: 'message_too_large' })
          );
        }
        req.destroy();
        resolve('too_large');
        return;
      }
      chunks.push(c);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (err: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onAborted = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve('aborted');
    };
    const onClose = (): void => {
      // `close` fires after every request — only treat as abort if
      // the stream hasn't ended cleanly.
      if (settled) return;
      settled = true;
      cleanup();
      resolve('aborted');
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
    req.on('close', onClose);
  });
}

export const submitHandler: Handler = async (req, res, ctx) => {
  const body = await readBodyBounded(req, res, ctx.maxMessageSizeBytes);
  if (body === 'too_large') {
    // Response already sent + socket destroyed inside readBodyBounded.
    return;
  }
  if (body === 'aborted') {
    // Client disconnected mid-upload. Nothing to respond to.
    return;
  }
  const url = new URL(req.url ?? '/', 'http://local');
  const hintTag = url.searchParams.get('contentTag') ?? undefined;
  const result = await ctx.poster.submit(
    new Uint8Array(body),
    hintTag ? { contentTag: hintTag as `0x${string}` } : undefined
  );
  if (result.accepted) {
    return sendJson(res, 201, { accepted: true, messageId: result.messageId });
  }
  return sendJson(res, rejectionToStatus(result.reason), {
    accepted: false,
    reason: result.reason,
  });
};

type ParsedLimit =
  | { ok: true; value: number | undefined }
  | { ok: false };

function parseLimit(limitStr: string | null): ParsedLimit {
  if (limitStr === null || limitStr === '') return { ok: true, value: undefined };
  if (!/^[0-9]+$/.test(limitStr)) return { ok: false };
  const n = Number(limitStr);
  if (!Number.isInteger(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

export const pendingHandler: Handler = async (req, res, ctx) => {
  const url = new URL(req.url ?? '/', 'http://local');
  const contentTag = url.searchParams.get('contentTag') ?? undefined;
  const limit = parseLimit(url.searchParams.get('limit'));
  if (!limit.ok) {
    return sendJson(res, 400, { error: 'invalid_query', field: 'limit' });
  }
  const pending = await ctx.poster.listPending({
    contentTag: contentTag as `0x${string}` | undefined,
    limit: limit.value,
  });
  return sendJson(res, 200, { pending });
};

export const submittedHandler: Handler = async (req, res, ctx) => {
  const url = new URL(req.url ?? '/', 'http://local');
  const contentTag = url.searchParams.get('contentTag') ?? undefined;
  const sinceBlockStr = url.searchParams.get('sinceBlock');

  let sinceBlock: bigint | undefined;
  if (sinceBlockStr !== null && sinceBlockStr !== '') {
    // Validate before handing to BigInt — a malformed value (e.g.
    // `?sinceBlock=abc`) would throw SyntaxError and bubble up as a
    // 500. Callers get a controlled 400 with a stable shape instead.
    if (!/^[0-9]+$/.test(sinceBlockStr)) {
      return sendJson(res, 400, { error: 'invalid_query', field: 'sinceBlock' });
    }
    sinceBlock = BigInt(sinceBlockStr);
  }

  const limit = parseLimit(url.searchParams.get('limit'));
  if (!limit.ok) {
    return sendJson(res, 400, { error: 'invalid_query', field: 'limit' });
  }

  const batches = await ctx.poster.listSubmittedBatches({
    contentTag: contentTag as `0x${string}` | undefined,
    limit: limit.value,
    sinceBlock,
  });
  return sendJson(res, 200, { batches });
};

export const statusHandler: Handler = async (_req, res, ctx) => {
  const status = await ctx.poster.status();
  return sendJson(res, 200, { status });
};

export const healthHandler: Handler = async (_req, res, ctx) => {
  const health = await ctx.poster.health();
  const status = health.state === 'unhealthy' ? 503 : health.state === 'degraded' ? 200 : 200;
  return sendJson(res, status, { health });
};

export const flushHandler: Handler = async (req, res, ctx) => {
  const url = new URL(req.url ?? '/', 'http://local');
  const contentTag = url.searchParams.get('contentTag');
  if (contentTag === null) {
    return sendJson(res, 400, { accepted: false, reason: 'malformed' });
  }
  // The flush endpoint is a nudge; the actual submission loop runs
  // autonomously. For synchronous flush in tests, the factory exposes
  // `_tickTag`. Over HTTP we acknowledge the request so callers don't
  // block on a flush.
  const internal = ctx.poster as unknown as { _tickTag?: (tag: `0x${string}`) => Promise<void> };
  if (typeof internal._tickTag === 'function') {
    await internal._tickTag(contentTag as `0x${string}`);
  }
  return sendJson(res, 200, { flushed: contentTag });
};
