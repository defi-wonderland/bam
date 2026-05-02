# bam-blog-demo

Third demo app on the BAM protocol. Where
[`message-in-a-blobble`](../message-in-a-blobble) is one global feed and
[`bam-twitter`](../bam-twitter) is a Twitter-style timeline, this app
recreates a Vitalik-style static blog with a BAM-backed comments
section under each post.

## Embedding the comments widget

The widget is a single `widget.js` you drop on any static page.
The integration surface is two lines of HTML:

```html
<div data-bam-comments data-post-id="my-post-slug"></div>
<script src="https://<your-host>/widget.js" defer></script>
```

That's it. The widget self-mounts on every `[data-bam-comments]`
element on the page (so a single page can carry multiple comment
threads if you want), reads `data-post-id` from each mount,
derives a `postIdHash` that rides inside the signed `contents`
payload, and renders the thread under the mount.

### Site isolation

By default the widget derives the post-id hash from the **pair**
`(siteId, postId)`, where `siteId` is `window.location.hostname`
at mount time. Two different sites that happen to pick the same
`data-post-id="my-post"` see independent threads — no cross-site
collisions.

Pin a stable `data-site-id` if you care about thread continuity
across hostnames (e.g. `www.x.com` ↔ `x.com`, or staging ↔ prod):

```html
<div data-bam-comments
     data-site-id="myblog.com"
     data-post-id="my-post"></div>
```

The exact preimage is:

```
keccak256(
  contentTag (32B) ‖ uint16BE(len(siteId)) ‖ utf8(siteId.toLowerCase()) ‖
                    uint16BE(len(postId)) ‖ utf8(postId)
)
```

`siteId` is lowercased (DNS hostname semantics); `postId` is
case-sensitive (host-controlled, opaque). The length-prefix
prevents `(siteId="ab", postId="cd")` from colliding with
`(siteId="abc", postId="d")` on a shared concatenation.

The demo's 5 pages pin `data-site-id="bam-blog-demo"` so dev,
preview, and prod all derive the same hashes against the live
fly.dev Poster + Reader.

Styles ship inlined in the bundle (scoped via CSS variables on
`[data-bam-comments]`), so no extra stylesheet is needed. Hosts
can override the palette by setting variables in their own CSS:

```css
[data-bam-comments] {
  --bam-color-anchor: #c3a554;
  --bam-color-text: #222;
}
```

Light / dark mode follows `prefers-color-scheme` by default; add
`class="bam-light"` or `class="bam-dark"` to the mount to force
a mode.

The bundle is `~28 KB` gzipped and includes `bam-sdk/browser` +
`viem`. It calls the upstream Poster + Reader directly from the
browser (URLs baked in at `vite build`), so the upstreams must
allow CORS.

## How it works

1. The 5 most recent posts on
   <https://github.com/vbuterin/blog> at authoring time are
   reproduced as short static HTML excerpts at the project root
   (`secure-llms.html`, `balance-of-power.html`, …) and act as
   the canonical embedder of the widget — same snippet a
   third-party site would use.

2. Each post page ends with:

   ```html
   <div data-bam-comments data-post-id="<slug>"></div>
   <script src="/widget.js" defer></script>
   ```

   In dev (`vite serve`), a tiny middleware aliases `/widget.js`
   to the source entry so HMR works on a single URL. In build
   (`vite build`), `dist/widget.js` is produced as a stable
   unhashed lib-mode bundle and the same URL resolves to it.

3. The widget reads `data-post-id` from each mount, derives
   `postIdHash = keccak256("bam-blog.v1:" + postId)`, polls the
   upstream Poster + Reader directly from the browser, filters
   to messages whose `postIdHash` matches the mounted post,
   builds a thread tree clamped at 2 levels of nesting, and
   renders to the DOM imperatively.

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
#     style.css      ← host page styles
#     theme.js       ← host page dark-mode toggle
#     widget.js      ← the embeddable widget (stable URL)
```

That directory **is** the deploy artifact. `widget.js` alone
(~28 KB gzipped) is the only file an external embedder needs;
the HTML files and `style.css` are just the demo's own pages
showing what an embedder might look like.

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

For the demo's own pages: the CSS palette, font stack (Inter /
system-ui sans-serif), container widths (760px markdown body
inside a 1200px shell), the
`<div id="doc" class="container-fluid markdown-body">` page
structure, the floated `<small>` byline, and the
`html.dark`-class-toggled dark mode (with localStorage
persistence and an inline pre-paint script) are taken directly
from `site/css/main.css` and the published post HTML in
<https://github.com/vbuterin/blog>. None of that ships in
`widget.js` — third-party hosts get only the widget's
self-scoped `[data-bam-comments]` palette, which inherits the
host page's font and adapts to its color scheme.

## Stack

- **Static HTML** — 5 hand-authored post pages + index, no
  generator. They're the canonical embedder of the widget,
  using the same snippet a third-party site would.
- **Vite** (lib mode) — bundles `src/widget/index.ts` →
  `dist/widget.js` (stable, unhashed). A small in-project
  plugin aliases `/widget.js` → source in dev so the same URL
  works in both modes; another copies the demo's HTML and
  `public/*` to `dist/` after build. Vite is already in the
  workspace via `vitest`; no new top-level dependency.
- **`bam-sdk` (browser)** — encoding, EIP-712 types,
  `messageHash` derivation.
- **`viem`** — `keccak256`, `Hex` types.
- **No React, Next.js, RainbowKit, wagmi, React Query, or
  Tailwind** — see `docs/specs/features/001-blog-comments/plan.md`
  *Constitution check IX*.

## License

MIT
