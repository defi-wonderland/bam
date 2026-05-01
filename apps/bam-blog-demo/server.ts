/**
 * Tiny static + API-proxy server for the blog comments demo.
 *
 * Serves three trees as same-origin static content:
 *
 *   posts/index.html          → GET /
 *   posts/<slug>.html         → GET /<slug>.html  (5 hand-authored)
 *   public/style.css          → GET /style.css
 *   dist/comments.js[.map]    → GET /comments.js[.map]   (Vite-built widget)
 *
 * And four `/api/*` routes: thin proxies to the shared Poster
 * and Reader, scoped to this demo's `contentTag`. The widget
 * never knows the upstream URLs — they live in `POSTER_URL` and
 * `READER_URL` (with sensible localhost defaults that match the
 * other two demos).
 *
 * In dev (`pnpm --filter bam-blog-demo dev`), this process also
 * starts Vite's build watcher in-process so changes under
 * `src/widget/*` rebuild `dist/comments.js` automatically — one
 * process, no `concurrently` dep.
 *
 * Lean by intent: ~150 LOC of `node:http` + `node:fs` + `fetch`
 * is the entire surface a static-blog operator would need to
 * deploy this on their own host.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { POSTS } from './posts/_slugs.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const PORT = Number.parseInt(process.env.PORT ?? '3002', 10);
const POSTER_URL = (process.env.POSTER_URL ?? 'http://localhost:8787').replace(
  /\/$/,
  ''
);
const READER_URL = (process.env.READER_URL ?? 'http://localhost:8788').replace(
  /\/$/,
  ''
);

const BLOG_TAG =
  '0xafe64111cc3b6a387f1cf4d4deb29d300bebc1748ff4d039459a6af86c6dab4b';

/**
 * Tags this server walks when computing per-sender next-nonce.
 * Matches `apps/bam-twitter/src/lib/constants.ts` `KNOWN_CONTENT_TAGS`
 * — the cross-app coordination point. New apps sharing the
 * Poster need to be appended here too.
 */
const KNOWN_CONTENT_TAGS: readonly string[] = [
  '0xf0fea94ffd2ae32ed878c57e3427bbffab46d333d09837bc640d952795090718', // bam-twitter.v1
  '0x323eee4675c068805a324c1a3a36805d446179434138f2f0872ac3f81b2e6591', // message-in-a-blobble.v1
  BLOG_TAG,
];

const SLUG_SET = new Set(POSTS.map((p) => p.slug));

const STATIC_ROOTS = {
  posts: resolve(__dirname, 'posts'),
  public: resolve(__dirname, 'public'),
  dist: resolve(__dirname, 'dist'),
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function serveFile(
  res: ServerResponse,
  root: string,
  rel: string
): Promise<boolean> {
  const safeRel = normalize(rel).replace(/^[/\\]+/, '');
  const full = join(root, safeRel);
  if (!full.startsWith(root)) {
    res.statusCode = 403;
    res.end('forbidden');
    return true;
  }
  try {
    const s = await stat(full);
    if (!s.isFile()) return false;
  } catch {
    return false;
  }
  const body = await readFile(full);
  res.statusCode = 200;
  res.setHeader('content-type', MIME[extname(full)] ?? 'application/octet-stream');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
  return true;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw === '') return null;
  return JSON.parse(raw);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function proxy(
  res: ServerResponse,
  upstreamUrl: string,
  init?: RequestInit
): Promise<void> {
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      ...init,
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    sendJson(res, 502, {
      error: 'upstream_unreachable',
      detail: err instanceof Error ? err.message : 'fetch failed',
    });
    return;
  }
  const contentType = upstream.headers.get('content-type') ?? 'application/json';
  const text = await upstream.text();
  res.statusCode = upstream.status;
  res.setHeader('content-type', contentType);
  res.end(text);
}

// /api/messages — GET pending, POST submit.
async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (req.method === 'GET') {
    await proxy(
      res,
      `${POSTER_URL}/pending?contentTag=${encodeURIComponent(BLOG_TAG)}`
    );
    return;
  }
  if (req.method === 'POST') {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { accepted: false, reason: 'malformed' });
      return;
    }
    const parsed =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    const message = parsed && 'message' in parsed ? parsed.message : body;
    const envelope = { contentTag: BLOG_TAG, message };
    await proxy(res, `${POSTER_URL}/submit`, {
      method: 'POST',
      body: JSON.stringify(envelope),
    });
    return;
  }
  res.statusCode = 405;
  res.end();
}

// /api/confirmed-messages — GET confirmed for this app, mapped
// to the wire shape the widget consumes (message_id =
// ERC-8180 messageHash, used as the unique id across pending/
// confirmed).
async function handleConfirmedMessages(
  res: ServerResponse
): Promise<void> {
  let upstream: Response;
  try {
    upstream = await fetch(
      `${READER_URL}/messages?contentTag=${encodeURIComponent(BLOG_TAG)}&status=confirmed`,
      { signal: AbortSignal.timeout(8_000) }
    );
  } catch (err) {
    sendJson(res, 502, {
      error: 'reader_unreachable',
      detail: err instanceof Error ? err.message : 'fetch failed',
    });
    return;
  }
  if (upstream.status !== 200) {
    res.statusCode = upstream.status;
    res.setHeader('content-type', 'application/json');
    res.end(await upstream.text());
    return;
  }
  const data = (await upstream.json()) as { messages?: ReaderMessageRow[] };
  const messages = (data.messages ?? []).flatMap((r) => {
    if (r.batchRef === null) return [];
    return [
      {
        message_id: r.messageHash,
        sender: r.author,
        nonce: r.nonce,
        contents: r.contents,
        signature: r.signature,
        tx_hash: r.batchRef,
        block_number: r.blockNumber,
        status: 'posted' as const,
      },
    ];
  });
  sendJson(res, 200, { messages });
}

interface ReaderMessageRow {
  messageId: string | null;
  author: string;
  nonce: string;
  contentTag: string;
  contents: string;
  signature: string;
  messageHash: string;
  status: string;
  batchRef: string | null;
  blockNumber: number | null;
}

// /api/post-blobble — POST flush this app's pending batch.
async function handlePostBlobble(res: ServerResponse): Promise<void> {
  await proxy(
    res,
    `${POSTER_URL}/flush?contentTag=${encodeURIComponent(BLOG_TAG)}`,
    { method: 'POST' }
  );
}

// /api/next-nonce — same logic as bam-twitter's route: walk
// Poster /pending (no tag filter) + Reader /messages once per
// known tag. Returns 502 on any upstream failure.
async function handleNextNonce(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const sender = url.searchParams.get('sender');
  if (sender === null || !/^0x[0-9a-fA-F]{40}$/.test(sender)) {
    sendJson(res, 400, { error: 'invalid_sender' });
    return;
  }
  const lc = sender.toLowerCase();
  let max = -1n;

  try {
    const r = await fetch(`${POSTER_URL}/pending`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (r.status !== 200) {
      sendJson(res, 502, {
        error: 'nonce_lookup_failed',
        detail: 'poster /pending non-200',
        upstreamStatus: r.status,
      });
      return;
    }
    const data = (await r.json()) as {
      pending?: Array<{ sender: string; nonce: string | number }>;
    };
    for (const p of data.pending ?? []) {
      if (p.sender.toLowerCase() !== lc) continue;
      const n = parseNonce(p.nonce);
      if (n !== null && n > max) max = n;
    }
  } catch {
    sendJson(res, 502, {
      error: 'nonce_lookup_failed',
      detail: 'poster /pending unreachable',
    });
    return;
  }

  for (const tag of KNOWN_CONTENT_TAGS) {
    try {
      const r = await fetch(
        `${READER_URL}/messages?contentTag=${encodeURIComponent(tag)}&status=confirmed`,
        { signal: AbortSignal.timeout(8_000) }
      );
      if (r.status !== 200) {
        sendJson(res, 502, {
          error: 'nonce_lookup_failed',
          detail: `reader /messages non-200 for tag ${tag}`,
          upstreamStatus: r.status,
        });
        return;
      }
      const data = (await r.json()) as {
        messages?: Array<{ author: string; nonce: string }>;
      };
      for (const row of data.messages ?? []) {
        if (row.author.toLowerCase() !== lc) continue;
        const n = parseNonce(row.nonce);
        if (n !== null && n > max) max = n;
      }
    } catch {
      sendJson(res, 502, {
        error: 'nonce_lookup_failed',
        detail: `reader /messages unreachable for tag ${tag}`,
      });
      return;
    }
  }

  sendJson(res, 200, { nextNonce: (max + 1n).toString() });
}

function parseNonce(v: string | number): bigint | null {
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

async function handleStatic(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const path = (req.url ?? '/').split('?')[0];

  if (path === '/' || path === '/index.html') {
    if (await serveFile(res, STATIC_ROOTS.posts, 'index.html')) return;
  }

  // Post pages: `/<slug>.html` for the 5 known slugs.
  const m = /^\/([a-z0-9-]+)\.html$/.exec(path);
  if (m !== null && SLUG_SET.has(m[1])) {
    if (await serveFile(res, STATIC_ROOTS.posts, `${m[1]}.html`)) return;
  }

  // Widget bundle.
  if (path === '/comments.js' || path === '/comments.js.map') {
    if (await serveFile(res, STATIC_ROOTS.dist, path.slice(1))) return;
  }

  // Anything else under /public.
  if (await serveFile(res, STATIC_ROOTS.public, path.slice(1))) return;

  res.statusCode = 404;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end('not found');
}

async function startViteWatcher(): Promise<void> {
  if (process.env.NODE_ENV === 'production') return;
  // Lazy-import vite so production starts cleanly without the dep
  // resolution roundtrip.
  const { build } = await import('vite');
  // Fire-and-forget watcher: rebuilds dist/comments.js on src changes.
  void build({
    configFile: resolve(__dirname, 'vite.config.ts'),
    build: { watch: {} },
    logLevel: 'warn',
  });
}

const server = createServer((req, res) => {
  const url = req.url ?? '';
  void (async () => {
    try {
      if (url.startsWith('/api/messages')) return await handleMessages(req, res);
      if (url.startsWith('/api/confirmed-messages'))
        return await handleConfirmedMessages(res);
      if (url.startsWith('/api/post-blobble')) return await handlePostBlobble(res);
      if (url.startsWith('/api/next-nonce')) return await handleNextNonce(req, res);
      return await handleStatic(req, res);
    } catch (err) {
      // Last-ditch — never leak the real exception text.
      // eslint-disable-next-line no-console
      console.error('[bam-blog-demo] unhandled', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
    }
  })();
});

void startViteWatcher();

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`bam-blog-demo listening on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`  POSTER_URL=${POSTER_URL}  READER_URL=${READER_URL}`);
});
