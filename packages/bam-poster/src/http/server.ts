import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';

/** Constant-time string equality. */
function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = Buffer.from(a);
  const bBytes = Buffer.from(b);
  if (aBytes.length !== bBytes.length) return false;
  return nodeTimingSafeEqual(aBytes, bBytes);
}

import type { Poster } from '../types.js';
import {
  flushHandler,
  healthHandler,
  pendingHandler,
  statusHandler,
  submitHandler,
  submittedHandler,
  type Handler,
  type RouteContext,
} from './routes.js';

export interface HttpServerOptions {
  host?: string;
  port?: number;
  poster: Poster;
  maxMessageSizeBytes: number;
  /**
   * Optional bearer token. When set, every request must carry
   * `Authorization: Bearer <token>`; missing / wrong token returns
   * 401. When unset (default), the server is open — operators are
   * expected to gate network access via a reverse proxy.
   */
  authToken?: string;
}

interface BoundRoute {
  method: 'GET' | 'POST';
  path: string;
  handler: Handler;
}

const ROUTES: BoundRoute[] = [
  { method: 'POST', path: '/submit', handler: submitHandler },
  { method: 'GET', path: '/pending', handler: pendingHandler },
  { method: 'GET', path: '/submitted-batches', handler: submittedHandler },
  { method: 'GET', path: '/status', handler: statusHandler },
  { method: 'GET', path: '/health', handler: healthHandler },
  { method: 'POST', path: '/flush', handler: flushHandler },
];

/**
 * Thin Node `http.createServer` router — no framework dep for 6
 * endpoints. Paths are exact-match; query strings pass through to the
 * handler.
 */
export class HttpServer {
  private readonly server: Server;
  private readonly ctx: RouteContext;
  private readonly authToken: string | undefined;

  constructor(opts: HttpServerOptions) {
    this.ctx = {
      poster: opts.poster,
      maxMessageSizeBytes: opts.maxMessageSizeBytes,
    };
    this.authToken = opts.authToken;
    this.server = createServer((req, res) => {
      void this.dispatch(req, res);
    });
    if (opts.port !== undefined) {
      this.server.listen(opts.port, opts.host ?? '127.0.0.1');
    }
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // Bearer-token gate. Runs before any handler so even a malformed
      // /submit can't reach the pool without auth.
      if (this.authToken !== undefined && !this.checkAuth(req)) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('WWW-Authenticate', 'Bearer realm="bam-poster"');
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      const url = new URL(req.url ?? '/', 'http://local');
      const route = ROUTES.find(
        (r) => r.method === req.method && r.path === url.pathname
      );
      if (!route) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        // 404 is an HTTP routing concern — not a PosterRejection. The
        // body carries a distinct `error` field to keep the rejection-
        // reason namespace closed.
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      await route.handler(req, res, this.ctx);
    } catch {
      // Never leak internal details.
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ accepted: false, reason: 'internal_error' }));
      } else {
        res.end();
      }
    }
  }

  private checkAuth(req: IncomingMessage): boolean {
    if (this.authToken === undefined) return true;
    const header = req.headers.authorization;
    if (typeof header !== 'string') return false;
    const [scheme, token] = header.split(' ', 2);
    if (scheme?.toLowerCase() !== 'bearer') return false;
    if (typeof token !== 'string' || token.length === 0) return false;
    // Constant-time comparison to avoid leaking token length via timing.
    return timingSafeEqual(token, this.authToken);
  }

  listen(port: number, host = '127.0.0.1'): Promise<void> {
    // Reject on startup errors (EADDRINUSE, EACCES, …) so the CLI /
    // tests surface a failed bind as a rejected promise rather than an
    // unhandled 'error' event (qodo review).
    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => {
        this.server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        this.server.removeListener('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(port, host);
    });
  }

  address(): { address: string; port: number } | null {
    const a = this.server.address();
    if (a === null || typeof a === 'string') return null;
    return { address: a.address, port: a.port };
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Exposed for test injection. */
  rawServer(): Server {
    return this.server;
  }
}
