# BAM Explorer

Read-only monitoring dashboard for a BAM Reader + Poster pair. Where the other demo apps in this repo (`bam-twitter`, `message-in-a-blobble`) each exercise an opinionated end-to-end use of BAM, **Explorer** is a "look at this page" answer for operators, demoers, and new contributors who want to see the stack producing data.

The page is **server-rendered** and **read-only by design**. There is no submit button, no flush button, and no API route that proxies a write — the Poster's `POST /submit` and `POST /flush` are deliberately not wired up here.

## What it surfaces

- **Poster** — `GET /health`, `GET /status`, `GET /pending`, `GET /submitted-batches`.
- **Reader** — `GET /health`, `GET /batches` (per configured content tag), `GET /messages` (per configured content tag), and a per-batch drill-down at `/batches/<txHash>` backed by the Reader's `GET /batches/:txHash`.

Each panel labels the upstream endpoint it reads, and renders one of four explicit states — **ok**, **not configured**, **unreachable**, or **error** — so a surprising number on the page is always traceable to a specific upstream call you can re-issue with `curl`. Panels degrade independently: if the Reader is down, the Poster panels still render, and vice versa.

## Refresh model

One-shot, server-rendered. A page load fetches every panel server-side in one pass; reload to re-fetch. The header shows a "fetched Ns ago" freshness indicator so you can tell how recent the snapshot is.

## Environment variables

All env vars are server-side. The Explorer's server-rendered routes never accept user-supplied upstream URLs.

| Env var | Required | Default | Purpose |
| --- | --- | --- | --- |
| `READER_URL` | optional¹ | — | Reader base URL (e.g. `http://localhost:8788`). |
| `READER_TIMEOUT_MS` | optional | `8000` | Per-request timeout against the Reader. |
| `POSTER_URL` | optional¹ | — | Poster base URL (e.g. `http://localhost:8787`). |
| `POSTER_AUTH_TOKEN` | optional | — | Bearer token forwarded to the Poster. Stays server-side; never echoed to the browser. |
| `EXPLORER_CONTENT_TAGS` | optional | — | Comma-separated `0x`-prefixed bytes32 content tags to surface in Reader-list panels. If empty/unset, those panels render the "no content tags configured" state; the rest of the page still works. |
| `EXPLORER_PENDING_LIMIT` | optional | `50` | Page size for Poster `/pending` (clamped to `[1, 200]`). |
| `EXPLORER_SUBMITTED_LIMIT` | optional | `50` | Page size for Poster `/submitted-batches` (clamped to `[1, 200]`). |
| `EXPLORER_BATCHES_LIMIT` | optional | `50` | Per-tag page size for Reader `/batches` (clamped to `[1, 200]`). |
| `EXPLORER_MESSAGES_LIMIT` | optional | `50` | Per-tag page size for Reader `/messages` (clamped to `[1, 200]`). |

¹ "Optional" in the sense that the app boots without it — the corresponding panels render "not configured" instead.

## Local dev

Point the Explorer at a Reader and Poster you already have running. The other demo apps (`bam-twitter`, `message-in-a-blobble`) use the same env-var contract, so any Reader/Poster pair already configured for those works here unchanged.

```sh
cd apps/bam-explorer
cp .env.local.example .env.local   # then edit
pnpm dev                           # serves on http://localhost:3003
```

`.env.local` for a typical local-dev setup:

```sh
READER_URL=http://localhost:8788
POSTER_URL=http://localhost:8787
EXPLORER_CONTENT_TAGS=0x<bytes32-tag-1>,0x<bytes32-tag-2>
```

## Tests

```sh
pnpm --filter bam-explorer test:run
```

Tests cover the env parser, both HTTP clients, every per-panel fetcher, the UI primitives (`StatusBadge`, `Freshness`), each panel component's degraded-state rendering, the batch-detail route, and a page-level integration test that pins the partial-offline posture (Reader down → Poster panels still render, and vice versa).

## What this app deliberately does **not** do

- No wallet, no signing, no submit flow. It does not depend on `wagmi` / `viem` / `rainbowkit`.
- No write proxy to the Poster. The Explorer's copy of `poster-client.ts` does not export `submitMessage` or `flush`, and the app contains no API route — by construction.
- No background polling. Reload the page to re-fetch.
- No multi-deployment switching. One Explorer instance points at one Reader URL and one Poster URL, like the existing demos.
