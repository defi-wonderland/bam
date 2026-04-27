/**
 * Minimal HTTP server for the Reader.
 *
 * Single endpoint (`GET /health`). Defaults to `127.0.0.1` per
 * red-team C-1; operators override via `READER_HTTP_BIND`. No
 * built-in auth; the operator fronts it.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import { healthHandler, type Handler, type RouteContext } from './routes.js';
import type { Reader } from '../factory.js';

export interface ReaderHttpServerOptions {
  reader: Reader;
  /** Default `127.0.0.1` — see red-team C-1. */
  host?: string;
  port?: number;
}

interface BoundRoute {
  method: 'GET';
  path: string;
  handler: Handler;
}

const ROUTES: BoundRoute[] = [
  { method: 'GET', path: '/health', handler: healthHandler },
];

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
      const url = new URL(req.url ?? '/', 'http://local');
      const route = ROUTES.find(
        (r) => r.method === req.method && r.path === url.pathname
      );
      if (!route) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      await route.handler(req, res, this.ctx);
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
