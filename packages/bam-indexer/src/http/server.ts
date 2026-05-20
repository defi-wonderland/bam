/**
 * HTTP server. Read-only, no auth, default bind `127.0.0.1` —
 * mirrors the Reader's posture. Routes come from two sources:
 *
 *   1. `BUILTIN_ROUTES` — `/health` today.
 *   2. Each handler's `routes` array, mounted at the path the
 *      handler declares (handlers prefix their own path with
 *      `/<handler.name>` so they can't collide).
 *
 * Path matching: literal match, with a single trailing `:name`
 * segment supported. Multi-param routes aren't needed at this scale
 * and would justify a router framework — punt on that until the
 * route table grows past a few entries per handler.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { Pool, PoolClient } from 'pg';

import type { BoundHandlerRoute } from '../framework/handler.js';
import type { HandlerRegistry } from '../framework/registry.js';
import { BUILTIN_ROUTES, type BuiltinRouteContext } from './routes.js';

export interface IndexerHttpServerOptions {
  chainId: number;
  registry: HandlerRegistry;
  writePool: Pool;
  host?: string;
  port?: number;
}

interface BuiltinDispatch {
  kind: 'builtin';
  route: (typeof BUILTIN_ROUTES)[number];
  pathParam: string | null;
}

interface HandlerDispatch {
  kind: 'handler';
  route: BoundHandlerRoute;
  pathParam: string | null;
}

type Dispatch = BuiltinDispatch | HandlerDispatch;

export class IndexerHttpServer {
  private readonly server: Server;
  private readonly host: string;
  private readonly ctx: BuiltinRouteContext;
  private readonly registry: HandlerRegistry;
  private readonly writePool: Pool;

  private constructor(opts: IndexerHttpServerOptions) {
    this.host = opts.host ?? '127.0.0.1';
    this.registry = opts.registry;
    this.writePool = opts.writePool;
    this.ctx = {
      chainId: opts.chainId,
      registry: opts.registry,
      writePool: opts.writePool,
      startedAt: Date.now(),
    };
    this.server = createServer((req, res) => {
      void this.dispatch(req, res);
    });
  }

  static async start(opts: IndexerHttpServerOptions): Promise<IndexerHttpServer> {
    const inst = new IndexerHttpServer(opts);
    await new Promise<void>((resolve, reject) => {
      inst.server.once('error', reject);
      inst.server.listen(opts.port ?? 0, inst.host, () => {
        inst.server.removeListener('error', reject);
        resolve();
      });
    });
    return inst;
  }

  port(): number {
    const addr = this.server.address();
    if (addr === null || typeof addr === 'string') {
      throw new Error('server is not listening on a TCP socket');
    }
    return addr.port;
  }

  hostname(): string {
    return this.host;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private match(method: string | undefined, pathname: string): Dispatch | null {
    if (method !== 'GET') return null;
    for (const r of BUILTIN_ROUTES) {
      if (r.path === pathname) {
        return { kind: 'builtin', route: r, pathParam: null };
      }
    }
    for (const handler of this.registry.all()) {
      for (const r of handler.routes) {
        const m = matchTemplate(r.path, pathname);
        if (m !== null) {
          return { kind: 'handler', route: r, pathParam: m.pathParam };
        }
      }
    }
    return null;
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Max-Age', '86400');
        res.statusCode = 204;
        res.end();
        return;
      }
      const url = new URL(req.url ?? '/', 'http://local');
      const matched = this.match(req.method, url.pathname);
      if (matched === null) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      if (matched.kind === 'builtin') {
        await matched.route.handler(req, res, this.ctx);
        return;
      }
      const client: PoolClient = await this.writePool.connect();
      try {
        await matched.route.handler(req, res, client);
      } finally {
        client.release();
      }
    } catch (err) {
      // Log so an operator sees the cause; never echo internals to clients.
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stderr.write(`[bam-indexer] http handler failed: ${detail}\n`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'internal_error' }));
      } else {
        res.end();
      }
    }
  }
}

function matchTemplate(
  template: string,
  pathname: string
): { pathParam: string | null } | null {
  const colonIdx = template.indexOf('/:');
  if (colonIdx < 0) {
    return template === pathname ? { pathParam: null } : null;
  }
  const prefix = template.slice(0, colonIdx + 1);
  if (!pathname.startsWith(prefix)) return null;
  const tail = pathname.slice(prefix.length);
  if (tail.length === 0 || tail.includes('/')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(tail);
  } catch {
    return null;
  }
  if (decoded.includes('/')) return null;
  return { pathParam: decoded };
}
