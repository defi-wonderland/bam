# bam-blog-demo

Third demo app on the BAM protocol. Where
[`message-in-a-blobble`](../message-in-a-blobble) is one global feed and
[`bam-twitter`](../bam-twitter) is a Twitter-style timeline, this app
recreates a Vitalik-style static blog with a BAM-backed comments
section under each post.

The point: **integrating BAM into a static HTML site is one
`<script type="module">` and one `<div id="comments">`.** The
post pages are hand-authored HTML, the widget is one ES-module
bundle, and the dev/prod server is ~250 lines of `node:http`.
No React, no Next.js, no wagmi.

## How it works

1. The 5 most recent posts on
   <https://github.com/vbuterin/blog> at authoring time are
   reproduced as short static HTML excerpts in `posts/<slug>.html`.
   Each ends with:

   ```html
   <div id="comments" data-post-slug="<slug>"></div>
   <script type="module" src="/comments.js"></script>
   ```

2. The widget (`src/widget/index.ts` → `dist/comments.js`) reads
   the slug from the mount node, derives
   `postIdHash = keccak256("bam-blog-demo.v1:" + slug)`, polls
   `/api/messages` and `/api/confirmed-messages`, decodes the
   demo's app-opaque payload, builds a thread tree clamped at 2
   levels of nesting, and renders to the DOM imperatively.

3. The widget signs comments with the user's wallet via raw
   `window.ethereum` (`eth_requestAccounts`,
   `eth_signTypedData_v4`). The EIP-712 typed-data shape is
   identical to what `bam-sdk` produces — pinned by
   `test/typed-data-parity.test.ts`.

4. Per-post scoping happens at the application layer: every
   demo comment ships under one `contentTag`
   (`bam-blog-demo.v1`), and the post id rides inside the
   signed `contents` payload. A relay can't re-attribute a
   signed comment to a different post without breaking
   signature verification.

## What's different from `message-in-a-blobble` and `bam-twitter`

|                | `message-in-a-blobble` | `bam-twitter`           | `bam-blog-demo` (this app) |
| -------------- | ---------------------- | ----------------------- | -------------------------- |
| Stack          | Next.js + React        | Next.js + React         | Static HTML + ES-module    |
| Wallet         | RainbowKit + wagmi     | RainbowKit + wagmi      | raw `window.ethereum`      |
| `contentTag`   | `message-in-a-blobble.v1` | `bam-twitter.v1`     | `bam-blog-demo.v1`         |
| App payload    | post-only              | post + reply            | comment + reply, per post  |
| Topic routing  | one feed               | one feed                | per-post (post id in payload) |
| Reply nesting  | n/a                    | unbounded               | clamped at depth 2         |
| Default port   | `:3000`                | `:3001`                 | `:3002`                    |
| Comments       | ~3 deps                | ~6 deps                 | 2 runtime deps (`bam-sdk`, `viem`) |

All three apps share one Poster + one Reader; isolation is by
`contentTag` alone.

## Wire format

Inside `contents[32:]` (the bytes after the contentTag prefix):

```
byte  0       : version    (uint8)  — currently 0x01
byte  1       : kind       (uint8)  — 0=comment, 1=reply
bytes 2..34   : postIdHash (bytes32) — keccak256("bam-blog-demo.v1:" + slug)
bytes 34..42  : timestamp  (uint64 BE)
[reply only]
bytes 42..74  : parentMessageHash (bytes32) — ERC-8180 messageHash
[both]
bytes K..K+4  : contentLen (uint32 BE)
bytes K+4..   : utf8 content
```

`K = 42` for `comment`, `K = 74` for `reply`. Source of truth:
`src/widget/codec.ts`. Round-trip + negative cases pinned in
`test/codec.test.ts`.

## Setup

Run all three demos against the shared Poster + Reader:

```bash
# from workspace root
pnpm install
pnpm --filter bam-sdk build
pnpm db:up
cp .env.local.example .env.local                          # Poster + Reader env
cp apps/bam-blog-demo/.env.example apps/bam-blog-demo/.env # this app's env

pnpm dev   # spawns Poster :8787, Reader :8788, blobble :3000, twitter :3001, blog-demo :3002
```

Or just this app:

```bash
pnpm --filter bam-blog-demo dev
# → http://localhost:3002
```

In dev, `server.ts` starts Vite's build watcher in-process so
edits under `src/widget/` rebuild `dist/comments.js`
automatically — one process, no `concurrently` dep.

For prod, `pnpm --filter bam-blog-demo build` produces
`dist/comments.js` and `pnpm --filter bam-blog-demo start`
runs the static + proxy server with `NODE_ENV=production`.

### Environment variables

| Variable     | Default                  | Description                            |
| ------------ | ------------------------ | -------------------------------------- |
| `POSTER_URL` | `http://localhost:8787`  | Shared `@bam/poster` instance          |
| `READER_URL` | `http://localhost:8788`  | Shared `bam-reader` instance           |
| `PORT`       | `3002`                   | Where this app's server listens        |

## API routes (server.ts → upstreams)

All five are thin proxies. The Poster and Reader handle the real
work.

| Route                          | Method | Proxies to                                             |
| ------------------------------ | ------ | ------------------------------------------------------ |
| `/api/messages`                | GET    | Poster `/pending?contentTag=BLOG_TAG`                  |
| `/api/messages`                | POST   | Poster `/submit` (envelope backfilled with `BLOG_TAG`) |
| `/api/confirmed-messages`      | GET    | Reader `/messages?contentTag=BLOG_TAG&status=confirmed` |
| `/api/post-blobble`            | POST   | Poster `/flush?contentTag=BLOG_TAG`                    |
| `/api/next-nonce?sender=0x..`  | GET    | Poster `/pending` (no tag) + Reader `/messages` per known tag |

`/api/next-nonce` is the **multi-app coordination point** — same
shape as `bam-twitter`'s. The Poster's monotonicity check is
per-sender across all tags, so a per-tag estimate live-locks any
wallet that has posted in another app on the same Poster. New
apps sharing this Poster need to be appended to
`KNOWN_CONTENT_TAGS` in `apps/bam-twitter/src/lib/constants.ts`
**and** the matching list at the top of `server.ts`.

## Smoke test

After `pnpm dev` brings everything up, walk this checklist
manually before merging — it covers every acceptance criterion
in `docs/specs/features/001-blog-comments/spec.md`:

- [ ] **(a)** Open `http://localhost:3002/secure-llms.html`,
      connect a Sepolia wallet, post a comment. It appears under
      the post first as `pending` then as `confirmed` after the
      next batch.
- [ ] **(b)** Reload the page. The confirmed comment is still
      there.
- [ ] **(c)** Click *Reply* on the top-level comment, post a
      reply (depth 1). Click *Reply* on the depth-1 reply, post
      another (depth 2).
- [ ] **(d)** On the depth-2 reply, the *Reply* affordance is
      absent — the depth cap is enforced.
- [ ] **(e)** Open `http://localhost:3002/balance-of-power.html`.
      The comment from (a) is **not** there.
- [ ] **(f)** Open `http://localhost:3001/` (bam-twitter) and
      `http://localhost:3000/` (message-in-a-blobble). The
      blog comment is not in either feed.
- [ ] **(g)** With a wallet that has already posted in
      `bam-twitter`, submit a blog comment. The Poster does not
      reject on monotonicity (cross-app nonce coordination
      works).
- [ ] **(h)** Stop the Reader (`pnpm --filter bam-reader dev`
      Ctrl-C) and reload `secure-llms.html`. The widget shows
      "Couldn't load comments" — distinct from the empty-state
      "No comments yet — be the first."
- [ ] **(i)** Disable JavaScript in the browser, reload
      `secure-llms.html`. The article and date render; the
      comments area shows the `<noscript>` fallback.

## Stack

- **Static HTML** — 5 hand-authored post pages + index, no
  generator.
- **Vite** — bundles `src/widget/index.ts` to
  `dist/comments.js`. Vite is already in the workspace via
  `vitest`; no new top-level dependency.
- **`bam-sdk` (browser)** — encoding, EIP-712 types,
  `messageHash` derivation.
- **`viem`** — `keccak256`, `Hex` types, type-only imports.
- **No React, Next.js, RainbowKit, wagmi, React Query, or
  Tailwind** — see `docs/specs/features/001-blog-comments/plan.md`
  *Constitution check IX*.

## License

MIT
