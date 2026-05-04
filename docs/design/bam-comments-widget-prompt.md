# Prompt — clean implementation of the BAM comments widget

Paste everything below into a fresh Claude session that has access to
this monorepo. The branch the previous attempt lives on is
`claude/add-blog-comments-ZUEFb` — useful as a reference, **not** as
a starting point. Start clean.

---

Build an **embeddable BAM-backed comments widget** plus a **minimal
demo** that embeds it. The widget is the deliverable; the demo is
illustration. Every constraint below is load-bearing — please honor
all of them literally; if any seems wrong, raise it before
implementing.

## Repo context

- pnpm monorepo. Existing apps in `apps/` (Next.js demos:
  `message-in-a-blobble`, `bam-twitter`). Existing packages in
  `packages/` (`bam-sdk`, `bam-poster`, `bam-reader`, `bam-store`,
  `bam-cli`, `bam-contracts`).
- Live upstreams: `https://bam-poster.fly.dev`,
  `https://bam-reader.fly.dev`. The widget calls them directly from
  the browser at runtime; assume CORS is open (verify, don't proxy).
- The Poster exposes `GET /nonce/<sender>` (added in PR #42) as the
  authoritative cross-tag next-nonce source. The widget calls it
  directly — there is **no** client-side fan-out across sibling
  apps' `contentTag`s, and **no** `KNOWN_CONTENT_TAGS` list to
  maintain.
- `bam-sdk` already has `"sideEffects": false` and a split
  `eip712.ts` so `import { EIP712_TYPES, computeECDSADigest } from
  'bam-sdk/browser'` does not pull in `@noble/bls12-381` or
  `@noble/secp256k1`. **Do not undo this** and do not import the SDK's
  `signECDSA*` / `verifyECDSA` functions from the widget.

## Layout

- New package `packages/bam-comments` — the widget. Builds to one
  unhashed `dist/widget.js` (Vite lib mode). Has its own tests. Could
  be npm-publishable later. Single ES-module entrypoint with auto-mount
  side effect.
- New app `apps/bam-blog-demo` — the demo. **2 hand-authored static
  HTML pages** (one index + one post) at the project root, plus
  `style.css` for the host page. Embeds the widget via the public
  embed snippet — same way an external site would. Vite's MPA mode is
  fine here for the host pages, but the widget itself is a separate
  build artifact in the `bam-comments` package, **not** rebuilt by the
  demo.
- The demo references the widget by its built file via a workspace
  `file:` link or a small copy step at build time. The script tag the
  demo's HTML uses is `<script src="/widget.js" defer></script>` —
  identical to what an external embedder writes.
- No Node server, no `server.ts`, no API proxy routes. The widget
  calls Poster + Reader directly. URLs baked in at build time via
  `VITE_POSTER_URL` / `VITE_READER_URL` (default to
  `localhost:8787` / `localhost:8788`).

## Embed contract (pin this on day 1)

```html
<div data-bam-comments
     data-post-id="<host-string>"
     data-site-id="<optional override>"></div>
<script src="https://<host>/widget.js" defer></script>
```

- The widget auto-mounts on every `[data-bam-comments]` element on
  the page. Idempotent (refuse to mount twice on the same node).
  Multiple instances per page allowed.
- `data-post-id` is host-controlled, opaque, case-sensitive.
- `data-site-id` resolves the per-site scope. If absent, fall back
  to `window.location.hostname.toLowerCase()`. siteId is
  case-insensitive (DNS hostname semantics).

## Cryptographic shape (pin this on day 1)

`contentTag` (32B, on-chain ERC-8179 indexed field):

```
contentTag = keccak256(utf8("bam-comments.v1"))
```

This is the only `contentTag` the widget submits under and the
only one it filters reads against. No need to register the tag
with sibling apps — cross-tag nonce coordination is handled by
the Poster's `/nonce/<sender>` endpoint (see *Per-sender nonce*
below).

`postIdHash` (32B, lives inside the signed `contents` payload — not
on-chain):

```
postIdHash = keccak256(
  contentTag (32B)
  ‖ uint16BE(len(siteIdBytes)) ‖ utf8(siteId.toLowerCase())
  ‖ uint16BE(len(postIdBytes)) ‖ utf8(postId)
)
```

Length-prefixing is non-negotiable — without it,
`("ab","cd")` collides with `("abc","d")`. Pin this in a unit test.

Wire format inside `contents[32:]` (after the 32-byte contentTag
prefix):

```
byte  0       : version (uint8) — 0x01
byte  1       : kind    (uint8) — 0=comment, 1=reply
bytes 2..34   : postIdHash (bytes32)
bytes 34..42  : timestamp (uint64 BE, Unix seconds)
[reply only]
bytes 42..74  : parentMessageHash (bytes32, the parent's ERC-8180 messageHash)
[both]
bytes K..K+4  : contentLen (uint32 BE)
bytes K+4..   : utf-8 content
```

`K = 42` for `comment`, `K = 74` for `reply`.

## Wallet path

- Raw `window.ethereum` (`eth_requestAccounts`, `eth_chainId`,
  `wallet_switchEthereumChain`, `eth_signTypedData_v4`,
  `accountsChanged` listener). One module wrapping it all.
- Map EIP-1193 errors to typed `WalletError` codes:
  `wallet_not_installed | request_rejected | unsupported_method |
  disconnected | bad_signature_shape | wrong_chain | unknown`.
  Raw provider strings never escape.
- Normalize the returned `v` byte from `{0,1}` to `{27,28}` so what
  the widget submits to the Poster is byte-identical to what
  `bam-sdk`'s `signECDSA` produces. Pin this with a parity test
  against `computeECDSADigest`.
- Sepolia (chain id `11155111`). If wallet is on a different chain,
  prompt to switch before signing; throw `wrong_chain` if the user
  declines.

## Thread builder

- API: `buildThread(messages: DecodedMessage[]): { roots:
  CommentNode[] }`. Single-bucket. Caller filters by mounted
  `postIdHash` upstream.
- Wire-level depth preserved; `displayDepth` clamped to `0 | 1 | 2`.
- Hide orphan replies (parent missing in bucket).
- Detect cycles in `parentMessageHash` chains (visited set during
  walk); drop every node on a cycle.
- Stable order: `(timestamp asc, messageHash asc)`. Apply
  recursively.

## Render

- Imperative DOM. No React/preact/lit. The widget exists to prove
  BAM is a script-tag drop-in.
- CSS inlined into the bundle (Vite's `?inline` import). Inject one
  `<style>` tag into `<head>` on first mount; idempotent across
  multi-instance pages.
- Scope every selector to `[data-bam-comments]` or
  `.bam-*` so nothing leaks into the host page.
- Themable via `--bam-color-*` CSS variables; `bam-light` /
  `bam-dark` classes on the mount force a mode. Default follows
  `prefers-color-scheme`.
- Pending vs confirmed visually distinguishable (a `pending` badge).
- Reply affordance hidden when `displayDepth === 2`.
- Composer preserves textarea focus + caret across full re-renders.
- Submission failures surface a typed error to the user and clear
  `busy`; do **not** retain the signed message client-side
  (the user must re-sign).

## Per-sender nonce

The Poster's monotonicity check is per-sender across every
`contentTag` it serves. Use its dedicated endpoint as the source
of truth — one call, one PK lookup, authoritative:

```
GET ${VITE_POSTER_URL}/nonce/${sender.toLowerCase()}
→ 200 { nextNonce: string }   (decimal uint64 as string)
```

On any non-200, treat the response as a hard error and surface a
typed failure to the user — do **not** fall back to scanning
`/pending` or the Reader's `/messages`. An underestimated
`nextNonce` round-trips through the Composer's `stale_nonce`
retry loop and exhausts on a stuck max; failing fast surfaces
the upstream problem instead of hiding it behind wallet popups.

No `KNOWN_CONTENT_TAGS` list, no fan-out, no per-tag walk.
Adding a new BAM app sharing this Poster does not require any
change to the widget.

## Bundle budget

**`widget.js` must be under 15 kB gzipped.** Honor `bam-sdk`'s
existing tree-shake-friendly shape (don't import `signatures.js`
transitively). If a future change in `bam-sdk` makes that hard,
fix it in `bam-sdk` rather than working around in the widget.

## Tests (Vitest, in the package)

- **codec.test.ts** — round-trip `comment` + `reply`; short buffer;
  unknown version; unknown kind; declared `contentLen` overrun;
  invalid UTF-8; non-32-byte `postIdHash`; non-32-byte
  `parentMessageHash`.
- **post-id.test.ts** — pinned hashes for ~5 representative
  `(siteId, postId)` pairs; cross-site isolation (same `postId`,
  different `siteId` → different hash); `siteId` case-insensitivity;
  `postId` case-sensitivity; length-prefix prevents
  `("ab","cd")` ↔ `("abc","d")` collision; empty-string rejection.
- **content-tag.test.ts** — pin `BAM_COMMENTS_TAG` matches
  `keccak256(utf8(NAMESPACE))`; pin the bytes32 literal.
- **thread.test.ts** — single comment → one root, displayDepth 0;
  reply → displayDepth 1; reply-of-reply → 2; depth-3 input clamps
  at 2; orphan reply hidden; self-cycle and 2-cycle break without
  loop; stable ordering with timestamp ties.
- **eth.test.ts** — stub provider; v-byte normalization
  (`0x00 → 0x1b`, `0x01 → 0x1c`, pass-through `0x1c`); error-code
  mapping (4001 → `request_rejected`, 4900 → `disconnected`, etc);
  no-provider → `wallet_not_installed`.
- **typed-data-parity.test.ts** — `hashTypedData(widget output)`
  must equal `computeECDSADigest` from `bam-sdk/browser` for
  several `(sender, nonce, contents, chainId)` fixtures.
- **embed-snippet.test.ts** (in the demo, not the package) — every
  HTML page in the demo carries `data-bam-comments`,
  `data-post-id`, and `<script src="/widget.js" defer>`.

## Out of scope (explicit — do not implement)

- React, Next.js, RainbowKit, wagmi, React Query, Tailwind, any
  CSS-in-JS library.
- A Node proxy server. The widget calls upstreams directly.
- Multi-page / MPA Vite build for the widget (the demo can use it,
  the widget cannot).
- Reply nesting deeper than 2.
- ENS / display-name resolution. Comments are attributed by raw
  address.
- Moderation, spam filtering, reputation.
- A "no-server" fallback that scans events directly from a beacon
  endpoint.
- Multi-chain support — Sepolia only.
- Authoring posts. The demo's pages are static fixtures.
- Retaining a signed message client-side after a submission failure.
  Surface the error and require re-sign.

## Workflow

1. Skim `apps/bam-twitter` and the existing
   `claude/add-blog-comments-ZUEFb` branch's `apps/bam-blog-demo`
   for shape only — **don't copy structure**, just confirm the
   wire-format conventions (envelope + `contents[32:]`).
2. Read `docs/specs/erc-8180.md` if you need a refresher on the
   envelope. Read `packages/bam-poster/src/surfaces/nonce.ts` and
   its HTTP route to understand the `/nonce/<sender>` shape the
   widget consumes.
3. Build the package first (codec → post-id → content-tag → thread
   → eth → typed-data → poster-reader → render → index). Tests
   alongside each module — interleave, don't batch.
4. Build the widget bundle and verify the size budget.
5. Build the demo last (2 HTML pages + style.css). Pin
   `data-site-id="bam-comments-demo"` so dev/preview/prod see the
   same threads.
6. Commit per coherent step; tests must be green at every commit.
7. Push to a new branch.

## Deliverable summary

```
packages/bam-comments/
├── package.json          ("sideEffects": false; private; workspace
│                          dep on bam-sdk; vite + vitest devDeps)
├── tsconfig.json
├── vite.config.ts        (lib mode; one entry → dist/widget.js)
├── vitest.config.ts
├── README.md             (embed snippet first; theming; site isolation)
├── src/
│   ├── index.ts          (auto-mount entrypoint; injects css; bootstraps)
│   ├── codec.ts
│   ├── content-tag.ts
│   ├── post-id.ts        (derivePostIdHash + resolveSiteId)
│   ├── thread.ts
│   ├── typed-data.ts
│   ├── eth.ts
│   ├── poster-reader.ts
│   ├── render.ts
│   └── widget.css        (scoped, themable via vars)
├── test/
│   ├── codec.test.ts
│   ├── content-tag.test.ts
│   ├── post-id.test.ts
│   ├── thread.test.ts
│   ├── typed-data-parity.test.ts
│   └── eth.test.ts
└── dist/                 (gitignored; widget.js + .map)

apps/bam-blog-demo/
├── package.json          (workspace dep on bam-comments)
├── index.html            (lists posts; embeds widget against an
│                          "index" post-id or omits the mount)
├── post-1.html           (one example post page)
├── post-2.html           (another example post page)
├── style.css             (host page styles only)
├── vite.config.ts
├── package.json scripts: dev / build / preview
└── (a tiny copy/link step that puts the widget's dist/widget.js
   at /widget.js in the demo's build output)
```

When you're done, the embed proof is: open
`apps/bam-blog-demo/dist/post-1.html` from any static host (or
`vite preview`), connect a wallet, post a comment, see it confirm
on Sepolia via the live Poster + Reader.
