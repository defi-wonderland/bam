/**
 * Framework-owned HTTP routes. The Twitter routes (and any future
 * handler routes) live with the handler module — they're mounted
 * here only as a list. Built-in:
 *
 *   GET /health → cursor lag per handler, registered handler set
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool, PoolClient } from 'pg';

import type { HandlerRegistry } from '../framework/registry.js';
import { getCursor } from '../framework/cursor.js';

export interface BuiltinRouteContext {
  chainId: number;
  registry: HandlerRegistry;
  writePool: Pool;
  startedAt: number;
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export interface BuiltinRoute {
  method: 'GET';
  path: string;
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    ctx: BuiltinRouteContext
  ) => Promise<void>;
}

const healthHandler = async (
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: BuiltinRouteContext
): Promise<void> => {
  const client: PoolClient = await ctx.writePool.connect();
  try {
    const cursors = [];
    for (const h of ctx.registry.all()) {
      const c = await getCursor(client, h.name);
      cursors.push({
        handler: h.name,
        version: h.version,
        contentTag: h.contentTag,
        lastBlockNumber: c?.lastBlockNumber ?? null,
        lastTxIndex: c?.lastTxIndex ?? null,
        lastMsgIndex: c?.lastMsgIndex ?? null,
        lastReorgInvalidatedAt: c?.lastReorgInvalidatedAt ?? null,
        updatedAt: c?.updatedAt ?? null,
      });
    }
    jsonResponse(res, 200, {
      chainId: ctx.chainId,
      uptimeMs: Date.now() - ctx.startedAt,
      handlers: ctx.registry.all().map((h) => ({
        name: h.name,
        version: h.version,
        contentTag: h.contentTag,
        schema: h.schema,
      })),
      cursors,
    });
  } finally {
    client.release();
  }
};

export const BUILTIN_ROUTES: BuiltinRoute[] = [
  { method: 'GET', path: '/health', handler: healthHandler },
];
