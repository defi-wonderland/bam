import type { IncomingMessage, ServerResponse } from 'node:http';

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

function bytesToHex(b: Uint8Array): string {
  return '0x' + Buffer.from(b).toString('hex');
}

/**
 * FU-4: read the request body up to `cap` bytes, and short-circuit
 * with a 413 + socket destroy as soon as the cap is exceeded. We
 * don't wait for `end` — an attacker streaming gigabytes would
 * otherwise tie up the socket even though we already know we'll
 * reject. Returns `'too_large'` (after responding + destroying) or
 * the full buffer once the client's body has completed.
 */
async function readBodyBounded(
  req: IncomingMessage,
  res: ServerResponse,
  cap: number
): Promise<Buffer | 'too_large'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const onData = (c: Buffer): void => {
      if (settled) return;
      total += c.length;
      if (total > cap) {
        settled = true;
        req.removeListener('data', onData);
        req.removeListener('end', onEnd);
        req.removeListener('error', onError);
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
      resolve(Buffer.concat(chunks));
    };
    const onError = (err: unknown): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

export const submitHandler: Handler = async (req, res, ctx) => {
  const body = await readBodyBounded(req, res, ctx.maxMessageSizeBytes);
  if (body === 'too_large') {
    // Response already sent + socket destroyed inside readBodyBounded.
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

export const pendingHandler: Handler = async (req, res, ctx) => {
  const url = new URL(req.url ?? '/', 'http://local');
  const contentTag = url.searchParams.get('contentTag') ?? undefined;
  const limitStr = url.searchParams.get('limit');
  const limit = limitStr ? Number(limitStr) : undefined;
  const pending = await ctx.poster.listPending({
    contentTag: contentTag as `0x${string}` | undefined,
    limit,
  });
  return sendJson(res, 200, { pending });
};

export const submittedHandler: Handler = async (req, res, ctx) => {
  const url = new URL(req.url ?? '/', 'http://local');
  const contentTag = url.searchParams.get('contentTag') ?? undefined;
  const limitStr = url.searchParams.get('limit');
  const sinceBlockStr = url.searchParams.get('sinceBlock');
  const batches = await ctx.poster.listSubmittedBatches({
    contentTag: contentTag as `0x${string}` | undefined,
    limit: limitStr ? Number(limitStr) : undefined,
    sinceBlock: sinceBlockStr ? BigInt(sinceBlockStr) : undefined,
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
