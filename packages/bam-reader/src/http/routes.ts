/**
 * HTTP route handlers for the Reader.
 *
 * The Reader exposes only `GET /health` for now. Auth is the
 * operator's responsibility (default bind is `127.0.0.1` per
 * red-team C-1).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Reader } from '../factory.js';

export interface RouteContext {
  reader: Reader;
}

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext
) => Promise<void>;

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  );
}

export const healthHandler: Handler = async (_req, res, ctx) => {
  const snapshot = await ctx.reader.health();
  jsonResponse(res, 200, snapshot);
};
