# bam-comments

A BAM-backed embeddable comments widget. One `<script>` tag, no
framework, no Node proxy.

## Embed snippet

```html
<div data-bam-comments
     data-post-id="my-post-1"
     data-site-id="example.com"></div>
<script src="https://your-cdn.example/widget.js" defer></script>
```

The script auto-mounts on every `[data-bam-comments]` element on the
page, including nodes added asynchronously after script execution.
Multiple instances per page are supported. Mounting is idempotent —
running the bootstrap twice on the same node is a no-op.

### Attributes

| Attribute        | Required | Notes                                                                                       |
| ---------------- | -------- | ------------------------------------------------------------------------------------------- |
| `data-post-id`   | yes      | Host-controlled, opaque, **case-sensitive**. The same `postId` on different sites is isolated. |
| `data-site-id`   | no       | Falls back to `window.location.hostname.toLowerCase()`. Case-insensitive (DNS semantics).   |

`(siteId, postId)` is hashed with `BAM_COMMENTS_TAG` and length-
prefixed siteId/postId bytes; that 32-byte digest is what threads are
keyed on. See `src/post-id.ts` for the exact layout.

## Theming

The widget uses CSS custom properties scoped to
`[data-bam-comments]`:

```css
[data-bam-comments] {
  --bam-color-bg: #fff;
  --bam-color-fg: #0f172a;
  --bam-color-accent: #2563eb;
  /* …see src/widget.css for the full list */
}
```

To force a colour scheme on a specific instance, add `bam-light` or
`bam-dark` to the mount node. Without either class, the widget
follows `prefers-color-scheme`.

## Site isolation

Different sites embedding bam-comments share one BAM Poster + Reader
deployment and one on-chain `contentTag`
(`keccak256(utf8("bam-comments.v1"))`), but each `(siteId, postId)`
pair derives a distinct `postIdHash` that's threaded through the
signed message contents. Threads on `a.example/post-1` and
`b.example/post-1` are kept separate by hash, not by transport.

## Build

```sh
pnpm -F bam-comments build
```

Output is a single un-hashed `dist/widget.js` (≈13 kB gzipped). The
filename is part of the public contract — the embed snippet
references it verbatim.

The size check at `pnpm -F bam-comments size` enforces the 15 kB
gzipped budget.

## Configuration

Build-time only — the widget calls upstreams directly with no env
handshake at runtime:

| Variable             | Default                   |
| -------------------- | ------------------------- |
| `VITE_POSTER_URL`    | `http://localhost:8787`   |
| `VITE_READER_URL`    | `http://localhost:8788`   |

For a Sepolia deploy:

```sh
VITE_POSTER_URL=https://bam-poster.fly.dev \
VITE_READER_URL=https://bam-reader.fly.dev \
pnpm -F bam-comments build
```

## Wallet

The widget only talks to `window.ethereum` directly:
`eth_requestAccounts`, `eth_chainId`, `wallet_switchEthereumChain`,
`eth_signTypedData_v4`, plus `accountsChanged`. No `wagmi`, no
`viem`'s wallet adapters. Only Sepolia (`11155111`) is supported.

## Confirmation latency

A submitted comment shows up immediately with a `pending` badge and
confirms when the Poster's aggregator bundles it into the next
batch. The widget does **not** call `/flush` per submit — that
endpoint nudges the aggregator's tick, and one tick per comment
would defeat the whole point of BAM aggregation (amortising blob
costs across many authors per batch). Operators that want a
shorter window should tune the Poster's batching policy
deployment-side, not in the widget.
