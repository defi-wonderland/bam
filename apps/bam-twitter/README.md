# BAM Twitter

Second demo app on the BAM protocol. Where [`message-in-a-blobble`](../message-in-a-blobble) is one feed of one message kind, this app is a Twitter-style timeline with **posts and replies**, and exists primarily to demonstrate that **multiple apps can share one Poster + one Reader**.

## How it works

1. **Connect** your wallet on Sepolia.
2. **Post** a message (280 char limit). The Composer ECDSA-signs the BAM envelope (`useSignTypedData`) and forwards it to the shared Poster's `/submit`.
3. **Reply** by clicking *Reply* on any tweet. The Composer switches to `kind=reply` and binds the parent's ERC-8180 `messageHash` into the payload.
4. **Confirm**. The shared Reader tails Sepolia for `BlobBatchRegistered` events, decodes the blob, verifies the signature, and writes confirmed rows into `bam-store`. Pending rows live in the Poster, confirmed rows in the Reader.

## What's different from `message-in-a-blobble`

| | `message-in-a-blobble` | `bam-twitter` |
|---|---|---|
| `contentTag` | `keccak256("message-in-a-blobble.v1")` | `keccak256("bam-twitter.v1")` |
| App-opaque payload | `u64 ts ‖ u32 len ‖ utf8` | `version (1) ‖ kind (1) ‖ kind-specific` |
| Message kinds | one (post-only) | two (post, reply) — extensible |
| Default port | `:3000` | `:3001` |

Otherwise identical: same `bam-sdk`, same Poster, same Reader, same Postgres `bam-store`. The two apps coexist because each picks a unique `contentTag` and the Poster/Reader filter on it.

## Wire format

`contents` carries the app body directly — `contentTag` is bound into
the signed digest, not prepended. Layout:

```
byte  0       : version (uint8)  — currently 0x01
byte  1       : kind    (uint8)  — 0=post, 1=reply
bytes 2..     : kind-specific payload
```

| kind | payload |
|---|---|
| `post` | `u64 BE timestamp ‖ u32 BE contentLen ‖ utf8 content` |
| `reply` | `u64 BE timestamp ‖ bytes32 parentMessageHash ‖ u32 BE contentLen ‖ utf8 content` |

`parentMessageHash` is the ERC-8180 `messageHash` (`keccak256(sender ‖ contentTag ‖ nonce ‖ contents)`) — chain-agnostic, computable pre-batch, and stable across the pending → confirmed transition. The Timeline groups replies under their parent on this hash; orphan replies (parent not in the visible window) are hidden.

The single source of truth for this codec is the `bam-sdk/post-reply` subpath (`packages/bam-sdk/src/post-reply/index.ts`), with round-trip + negative tests alongside it at `packages/bam-sdk/src/post-reply/index.test.ts`. The codec is generic (post + one-level reply over utf-8 content) so any app that wants this shape can pick a unique contentTag and reuse it. Browser-safe (audited in `packages/bam-sdk/tests/post-reply-browser-audit.test.ts`), used by the Composer here and by the `bam-indexer`'s post-reply handler (instantiated as `twitter` in `packages/bam-indexer/src/bin/bam-indexer.ts`).

## Setup

Run the shared Poster + Reader with the blobble demo and this app side by side:

```bash
# from workspace root
pnpm install
pnpm --filter bam-sdk build
pnpm db:up
cp .env.local.example .env.local                                # Poster/Reader env
cp apps/bam-twitter/.env.local.example apps/bam-twitter/.env.local

pnpm dev   # spawns Poster :8787, Reader :8788, blobble :3000, twitter :3001
```

Both demos hit the same `POSTER_URL=http://localhost:8787` and `READER_URL=http://localhost:8788`; their feeds stay isolated by `contentTag` alone.

### Environment variables

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_RPC_URL` | Sepolia execution RPC (browser bundle) |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | RainbowKit / WalletConnect project id |
| `POSTER_URL` | Shared `@bam/poster` (default `http://localhost:8787`) |
| `READER_URL` | Shared `bam-reader` (default `http://localhost:8788`) |
| `INDEXER_URL` | Optional. When set, `/api/confirmed-messages` prefers the indexer's pre-decoded rows over the Reader fallback. |

## API routes

All are thin proxies. The Poster, Reader, and Indexer handle the real work.

| Route | Method | Proxies to |
|---|---|---|
| `/api/messages` | GET | Poster `/pending?contentTag=TWITTER_TAG` |
| `/api/messages` | POST | Poster `/submit` (envelope backfilled with `TWITTER_TAG`) |
| `/api/confirmed-messages` | GET | Indexer `/twitter/posts` when `INDEXER_URL` is set; Reader `/messages?contentTag=TWITTER_TAG&status=confirmed` otherwise |
| `/api/thread/[messageHash]` | GET | Indexer `/twitter/posts/hash/:hash` + `/twitter/replies`; Reader fallback decodes raw contents |
| `/api/post-blobble` | POST | Poster `/flush?contentTag=TWITTER_TAG` |
| `/api/next-nonce` | GET | Poster `/pending` (no tag) + Reader `/messages` per known tag |

`/api/next-nonce` is the **multi-app coordination point**. The Poster's monotonicity check is per sender across all tags (`packages/bam-poster/src/ingest/monotonicity.ts`), so a per-tag nonce estimate live-locks any wallet that has posted in another app on the same Poster. This route walks the Poster's pending queue (no tag filter) plus the Reader's confirmed view once per known tag — `KNOWN_CONTENT_TAGS` in `src/lib/constants.ts`.

A new app sharing this Poster needs to be appended to `KNOWN_CONTENT_TAGS`. Long-term that should be replaced by a Poster-side `/nonce/:sender` endpoint.

## Stack

- **Next.js 15** (App Router), **Tailwind CSS**
- **RainbowKit + wagmi** — wallet connection
- **React Query** — data fetching + cache
- **bam-sdk** (browser entrypoint) — encoding, EIP-712 types, `messageHash`
- **viem** — types + signing primitives via wagmi

## License

MIT
