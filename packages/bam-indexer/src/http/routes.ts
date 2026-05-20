/**
 * Framework-owned HTTP routes. The post-reply handler routes live
 * with the handler module — they're mounted here only as a list.
 * Built-in:
 *
 *   GET /health → cursor + generation state per handler
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool, PoolClient } from 'pg';

import type { HandlerRegistry } from '../framework/registry.js';
import { getCurrentCursor, listCursors } from '../framework/cursor.js';

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
  ctx: BuiltinRouteContext,
): Promise<void> => {
  const client: PoolClient = await ctx.writePool.connect();
  try {
    const cursors = [];
    const versions = [];
    for (const h of ctx.registry.all()) {
      const current = await getCurrentCursor(client, h.name);
      cursors.push({
        handler: h.name,
        version: h.version,
        versionId: current?.versionId ?? null,
        contentTag: h.contentTag,
        lastBlockNumber: current?.lastBlockNumber ?? null,
        lastTxIndex: current?.lastTxIndex ?? null,
        lastMsgIndex: current?.lastMsgIndex ?? null,
        lastReorgInvalidatedAt: current?.lastReorgInvalidatedAt ?? null,
        updatedAt: current?.updatedAt ?? null,
      });
      for (const c of await listCursors(client, h.name)) {
        versions.push({
          handler: h.name,
          versionId: c.versionId,
          handlerVersion: c.handlerVersion,
          isCurrent: c.isCurrent,
          supersededAt: c.supersededAt,
          lastBlockNumber: c.lastBlockNumber,
          lastTxIndex: c.lastTxIndex,
          lastMsgIndex: c.lastMsgIndex,
          lastReorgInvalidatedAt: c.lastReorgInvalidatedAt,
          updatedAt: c.updatedAt,
        });
      }
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
      versions,
    });
  } finally {
    client.release();
  }
};

export const BUILTIN_ROUTES: BuiltinRoute[] = [
  { method: 'GET', path: '/health', handler: healthHandler },
];
