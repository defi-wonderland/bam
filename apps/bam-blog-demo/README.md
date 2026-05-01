# bam-blog-demo

Third demo app on the BAM protocol. Where
[`message-in-a-blobble`](../message-in-a-blobble) is one global feed and
[`bam-twitter`](../bam-twitter) is a Twitter-style timeline, this app
recreates a Vitalik-style static blog with a BAM-backed comments
section under each post.

The point: **integrating BAM into a static HTML site is one
`<script type="module">` and one `<div id="comments">`.** The
post pages are hand-authored HTML, the widget is one ES-module
bundle, and the entire deploy artifact is a `dist/` directory of
static files — no Node server. No React, no Next.js, no wagmi.

## How it works

1. The 5 most recent posts on
   <https://github.com/vbuterin/blog> at authoring time are
   reproduced as short static HTML excerpts at the project root
   (`secure-llms.html`, `balance-of-power.html`, …). Each ends
   with:

   ```html
   <div id="comments" data-post-slug="<slug>"></div>
   <script type="module" src="/src/widget/index.ts"></script>
   ```

   Vite bundles the widget at build time; the script tag is
   rewritten to a hashed asset.

2. The widget reads the slug from the mount node, derives
   `postIdHash = keccak256("bam-blog.v1:" + slug)`, polls
   the upstream Poster + Reader directly from the browser,
   decodes the demo's app-opaque payload, builds a thread tree
   clamped at 2 levels of nesting, and renders to the DOM
   imperatively.

3. The widget signs comments with the user's wallet via raw
   `window.ethereum` (`eth_requestAccounts`,
   `eth_signTypedData_v4`). The EIP-712 typed-data shape is
   identical to what `bam-sdk` produces — pinned by
   `test/typed-data-parity.test.ts`. The user only **signs**
   the message — the Poster pays gas to batch and submit, so a
   commenter doesn't need any Sepolia ETH.

4. Per-post scoping happens at the application layer: every
   demo comment ships under one `contentTag`
   (`bam-blog.v1`), and the post id rides inside the
   signed `contents` payload. A relay can't re-attribute a
   signed comment to a different post without breaking
   signature verification.

## What's different from `message-in-a-blobble` and `bam-twitter`

|                | `message-in-a-blobble` | `bam-twitter`           | `bam-blog-demo` (this app) |
| -------------- | ---------------------- | ----------------------- | -------------------------- |
| Stack          | Next.js + React        | Next.js + React         | Static HTML + Vite-bundled widget |
| Server tier    | Next.js API routes     | Next.js API routes      | none — pure static deploy  |
| Wallet         | RainbowKit + wagmi     | RainbowKit + wagmi      | raw `window.ethereum`      |
| `contentTag`   | `message-in-a-blobble.v1` | `bam-twitter.v1`     | `bam-blog.v1`              |
| App payload    | post-only              | post + reply            | comment + reply, per post  |
| Topic routing  | one feed               | one feed                | per-post (post id in payload) |
| Reply nesting  | n/a                    | unbounded               | clamped at depth 2         |
| Default port   | `:3000`                | `:3001`                 | `:3002`                    |
| Runtime deps   | ~3                     | ~6                      | 2 (`bam-sdk`, `viem`)      |

All three apps share one Poster + one Reader; isolation is by
`contentTag` alone.

## Wire format

Inside `contents[32:]` (the bytes after the contentTag prefix):

```
byte  0       : version    (uint8)  — currently 0x01
byte  1       : kind       (uint8)  — 0=comment, 1=reply
bytes 2..34   : postIdHash (bytes32) — keccak256("bam-blog.v1:" + slug)
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

## Quick look (against the live fly.dev Poster + Reader)

```bash
git checkout claude/add-blog-comments-ZUEFb
pnpm install
pnpm --filter bam-sdk build

VITE_POSTER_URL=https://bam-poster.fly.dev \
VITE_READER_URL=https://bam-reader.fly.dev \
  pnpm --filter bam-blog-demo dev
# → http://localhost:3002
```

Reading existing comments works without a wallet. To author,
connect any Ethereum wallet (no Sepolia ETH needed — the user
only signs; the Poster pays gas to submit).

> **CORS note.** The browser calls `bam-poster.fly.dev` and
> `bam-reader.fly.dev` directly. They must send
> `Access-Control-Allow-Origin: *` (or whitelist the deploy
> origin). If they don't, you'll see CORS errors in the
> console.

## Static deploy

The same env vars at `vite build` time produce a fully static
`dist/` you can drop on any CDN, S3, Vercel static, Netlify,
GitHub Pages, IPFS, Cloudflare Pages — anywhere that serves
files.

```bash
VITE_POSTER_URL=https://bam-poster.fly.dev \
VITE_READER_URL=https://bam-reader.fly.dev \
  pnpm --filter bam-blog-demo build
# → apps/bam-blog-demo/dist/
#     index.html
#     secure-llms.html
#     balance-of-power.html
#     societies.html
#     plinko.html
#     galaxybrain.html
#     style.css
#     theme.js
#     assets/<hashed-bundle>.js
```

That directory **is** the deploy artifact. Roughly 25 KB
gzipped of widget JS plus six tiny HTML pages.

To preview the production build locally:

```bash
pnpm --filter bam-blog-demo preview
# → http://localhost:3002 serving from dist/
```

## Environment variables

| Variable           | Required | Description                                    |
| ------------------ | -------- | ---------------------------------------------- |
| `VITE_POSTER_URL`  | yes      | Public URL of the upstream `@bam/poster`       |
| `VITE_READER_URL`  | yes      | Public URL of the upstream `bam-reader`        |

Both are consumed at build time (and dev-time `vite serve`).
Vite bakes them into the bundle. There are no runtime env vars
— this is a static site.

## Cross-app coordination

The widget computes per-sender next-nonce client-side by walking
the Poster's `/pending` (no tag filter) plus the Reader's
`/messages` once per known `contentTag`. The Poster's
monotonicity check is per sender across all tags, so a per-tag
estimate would live-lock any wallet that has posted in another
app on the same Poster.

The list of known tags lives in
`src/widget/content-tag.ts` — mirror of
`apps/bam-twitter/src/lib/constants.ts` `KNOWN_CONTENT_TAGS`.
New apps sharing this Poster need to be appended to both.

## Smoke test

Run `pnpm --filter bam-blog-demo dev` against the live fly.dev
upstreams (or a local Poster + Reader) and walk this list — it
covers every acceptance criterion in
`docs/specs/features/001-blog-comments/spec.md`:

- [ ] **(a)** Open `http://localhost:3002/secure-llms.html`,
      connect a wallet, post a comment. It appears first as
      `pending`, then as `confirmed` after the next Poster
      batch.
- [ ] **(b)** Reload the page. The confirmed comment is still
      there.
- [ ] **(c)** Click *Reply* on the top-level comment, post a
      reply (depth 1). Click *Reply* on the depth-1 reply,
      post another (depth 2).
- [ ] **(d)** On the depth-2 reply, the *Reply* affordance is
      absent — the depth cap is enforced.
- [ ] **(e)** Open `http://localhost:3002/balance-of-power.html`.
      The comment from (a) is **not** there.
- [ ] **(f)** Open `http://localhost:3001/` (bam-twitter) and
      `http://localhost:3000/` (message-in-a-blobble). The
      blog comment is not in either feed.
- [ ] **(g)** With a wallet that has already posted in
      `bam-twitter`, submit a blog comment. The Poster does
      not reject on monotonicity.
- [ ] **(h)** Block `bam-reader.fly.dev` (browser devtools
      → Network → block) and reload. The widget shows
      "Couldn't load comments" — distinct from the empty-state
      "No comments yet — be the first."
- [ ] **(i)** Disable JavaScript in the browser, reload
      `secure-llms.html`. The article and date render; the
      comments area shows the `<noscript>` fallback.

## Visual parity with vitalik.eth.limo

The CSS palette, font stack (Inter / system-ui sans-serif),
container widths (760px markdown body inside a 1200px shell),
the `<div id="doc" class="container-fluid markdown-body">` page
structure, the floated `<small>` byline, and the
`html.dark`-class-toggled dark mode (with localStorage
persistence and an inline pre-paint script that avoids
flash-of-wrong-theme) are taken directly from
`site/css/main.css` and the published post HTML in
<https://github.com/vbuterin/blog>. The widget-rendered classes
(`.bam-*`) are mine and inherit the same palette so the
comments section visually belongs to the page.

## Stack

- **Static HTML** — 5 hand-authored post pages + index, no
  generator.
- **Vite** (MPA mode) — bundles `src/widget/index.ts` to a
  hashed asset and copies `public/*` to the deploy root. Vite
  is already in the workspace via `vitest`; no new top-level
  dependency.
- **`bam-sdk` (browser)** — encoding, EIP-712 types,
  `messageHash` derivation.
- **`viem`** — `keccak256`, `Hex` types.
- **No React, Next.js, RainbowKit, wagmi, React Query, or
  Tailwind** — see `docs/specs/features/001-blog-comments/plan.md`
  *Constitution check IX*.

## License

MIT
