# BAM Explorer

Read-only monitoring dashboard for a BAM Reader + Poster pair. Where the other demo apps in this repo (`bam-twitter`, `message-in-a-blobble`) each exercise an opinionated end-to-end use of BAM, **Explorer** is a "look at this page" answer for operators, demoers, and new contributors who want to see the stack producing data.

The page is **fully client-rendered** and **read-only by design**. The Explorer's Next.js server only serves a static HTML shell + JS bundle; every fetch to the Reader and Poster happens directly from the viewer's browser. There is no submit button, no flush button, and no API route — the Poster's `POST /submit` and `POST /flush` are deliberately not wired up.

## What it surfaces

- **Poster** — `GET /health`, `GET /status`, `GET /pending`, `GET /submitted-batches`.
- **Reader** — `GET /health`, `GET /batches` (per configured content tag), `GET /messages` (per configured content tag), and a per-batch drill-down at `/batches/<txHash>` backed by the Reader's `GET /batches/:txHash`.

Each panel labels the upstream endpoint it reads, and renders one of four explicit states — **ok**, **not configured**, **unreachable**, or **error** — so a surprising number on the page is always traceable to a specific upstream call you can re-issue with `curl`. Panels degrade independently: if the Reader is down, the Poster panels still render, and vice versa.

## Configuration: env defaults + per-viewer Settings

Two configuration sources, in priority order:

1. **Settings** — a panel in the page header lets the viewer override the Reader URL, Poster URL, Poster bearer token, and content-tags list. Values persist in `localStorage` and survive reloads. Clearing a field reverts to the build-time default.
2. **Build-time env** — `NEXT_PUBLIC_DEFAULT_*` baked into the bundle. **No token default** — a deployed Explorer never serves an operator's bearer token to anonymous visitors.

When a Reader/Poster URL has been overridden, an "override" pill appears next to the affected panels' endpoint label so the viewer can see the displayed data is not from the build-time default.

### Build-time env vars (defaults baked into the bundle)

| Env var | Default | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_DEFAULT_READER_URL` | — | Default Reader base URL (e.g. `http://localhost:8788`). Empty → Reader panels render "not configured" until the viewer sets one in Settings. |
| `NEXT_PUBLIC_DEFAULT_POSTER_URL` | — | Default Poster base URL. Same not-configured semantics as Reader. |
| `NEXT_PUBLIC_DEFAULT_CONTENT_TAGS` | — | Comma-separated `0x`-prefixed bytes32 default content tags. Reader-list panels group by tag. Empty → Reader-list panels render "no content tags configured" until the viewer adds tags in Settings. |

Note: there is **no** `NEXT_PUBLIC_DEFAULT_POSTER_AUTH_TOKEN`. A bearer token can only be entered per-viewer through Settings; it is stored in that viewer's `localStorage` and sent as `Authorization: Bearer …` on outbound Poster fetches.

### Per-panel limits

Defaults: 50 each. Per-viewer overrides via Settings (clamped to `[1, 200]`). The Reader caps at 1000 and the Poster at 10 000, so 50 is well within both and human-scannable.

## Local dev

Both upstreams (`bam-reader`, `@bam/poster`) already CORS-allow `*` and accept the `Authorization` header on the relevant routes, so the browser-direct fetch works out of the box.

```sh
cd apps/bam-explorer
cp .env.local.example .env.local   # then edit
pnpm dev                           # serves on http://localhost:3003
```

`.env.local` for a typical local-dev setup:

```sh
NEXT_PUBLIC_DEFAULT_READER_URL=http://localhost:8788
NEXT_PUBLIC_DEFAULT_POSTER_URL=http://localhost:8787
NEXT_PUBLIC_DEFAULT_CONTENT_TAGS=0x<bytes32-tag-1>,0x<bytes32-tag-2>
```

If you want the Explorer to come up empty so every viewer types their own URLs in Settings, leave the env vars blank — the page still works, it just renders "not configured" until the viewer fills in Settings.

## Tests

```sh
pnpm --filter bam-explorer test:run
```

Tests cover env parsing, the `useExplorerConfig` hook (env defaults / overrides / corrupt-storage fallback / "no token from env"), both HTTP clients, every per-panel fetcher, the UI primitives (`StatusBadge`, `Freshness`, `SettingsPanel`), each panel component's degraded-state rendering and override-flag rendering, the batch-detail card, and a Dashboard integration test that pins:

- happy-path rendering of all panels with their endpoint labels,
- partial-offline posture (Reader-down → Poster panels still ok, and vice versa),
- the "no content tags configured" state,
- the "override active" pill appearing next to the affected panels,
- freshness indicator + working Refresh button.

## What this app deliberately does **not** do

- No wallet, no signing, no submit flow. It does not depend on `wagmi` / `viem` / `rainbowkit`.
- No write proxy to the Poster. The Explorer's copy of `poster-client.ts` does not export `submitMessage` or `flush`, and the app contains no API route — by construction.
- No outbound network call from the Explorer's server. All upstream fetches happen from the viewer's browser.
- No build-time default for the Poster bearer token. A deployed Explorer never ships an operator's token to anonymous visitors.
- No background polling. Use the Refresh button.
- No multi-deployment switching with shared state. Each viewer's Settings live in their own `localStorage` only.
