/**
 * Minimal HTTP server for the Reader.
 *
 * Read-only by design — every entry in `ROUTES` is `GET`. The route
 * table is the single point where handlers are registered, which makes
 * a future write-surface regression visible at review time and asserted
 * by `tests/unit/http.test.ts` (gate G-5 in feature 005's plan).
 *
 * Defaults to `127.0.0.1` per red-team C-1; operators override via
 * `READER_HTTP_BIND`. No built-in auth; the operator fronts it.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import {
  batchByTxHashHandler,
  batchesHandler,
  healthHandler,
  messagesHandler,
  type Handler,
  type RouteContext,
} from './routes.js';
import type { Reader } from '../factory.js';

export interface ReaderHttpServerOptions {
  reader: Reader;
  /** Default `127.0.0.1` — see red-team C-1. */
  host?: string;
  port?: number;
}

/**
 * A bound route. `path` is either a literal pathname (`/health`) or a
 * pattern with a single trailing path-parameter segment encoded as
 * `:name` (`/batches/:txHash`). Two patterns are not supported per
 * route — three GET routes don't justify a router framework
 * (constitution principle IX).
 */
export interface BoundRoute {
  method: 'GET';
  path: string;
  handler: Handler;
}

export const ROUTES: BoundRoute[] = [
  { method: 'GET', path: '/health', handler: healthHandler },
  { method: 'GET', path: '/messages', handler: messagesHandler },
  { method: 'GET', path: '/batches', handler: batchesHandler },
  { method: 'GET', path: '/batches/:txHash', handler: batchByTxHashHandler },
];

interface MatchedRoute {
  route: BoundRoute;
  pathParam: string | null;
}

function matchRoute(
  method: string | undefined,
  pathname: string
): MatchedRoute | null {
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const colonIdx = r.path.indexOf('/:');
    if (colonIdx < 0) {
      if (r.path === pathname) return { route: r, pathParam: null };
      continue;
    }
    const prefix = r.path.slice(0, colonIdx + 1); // include trailing `/`
    if (!pathname.startsWith(prefix)) continue;
    const tail = pathname.slice(prefix.length);
    if (tail.length === 0 || tail.includes('/')) continue;
    // Malformed percent-encoding (e.g. `%ZZ`) makes
    // `decodeURIComponent` throw `URIError`; treat the request as a
    // route mismatch (→ 404) rather than letting it bubble to the
    // dispatcher and surface as a generic 500.
    let decoded: string;
    try {
      decoded = decodeURIComponent(tail);
    } catch {
      continue;
    }
    // Re-check for `/` AFTER decoding: a percent-encoded slash (`%2F`)
    // passes the raw-tail check above but decodes to `/`, which would
    // smuggle a multi-segment value through the single-:param router.
    if (decoded.includes('/')) continue;
    return { route: r, pathParam: decoded };
  }
  return null;
}

export class ReaderHttpServer {
  private readonly server: Server;
  private readonly ctx: RouteContext;
  private readonly host: string;

  private constructor(opts: ReaderHttpServerOptions) {
    this.host = opts.host ?? '127.0.0.1';
    this.ctx = { reader: opts.reader };
    this.server = createServer((req, res) => {
      void this.dispatch(req, res);
    });
  }

  static async start(opts: ReaderHttpServerOptions): Promise<ReaderHttpServer> {
    const inst = new ReaderHttpServer(opts);
    await new Promise<void>((resolve, reject) => {
      inst.server.once('error', reject);
      inst.server.listen(opts.port ?? 0, inst.host, () => {
        inst.server.removeListener('error', reject);
        resolve();
      });
    });
    return inst;
  }

  /** Returns the actual port the server is bound to (post-listen). */
  port(): number {
    const addr = this.server.address();
    if (addr === null || typeof addr === 'string') {
      throw new Error('server is not listening on a TCP socket');
    }
    return addr.port;
  }

  /** Returns the host the server is bound to. */
  hostname(): string {
    return this.host;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
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
      const matched = matchRoute(req.method, url.pathname);
      if (!matched) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      await matched.route.handler(req, res, this.ctx, {
        url,
        pathParam: matched.pathParam,
      });
    } catch {
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
