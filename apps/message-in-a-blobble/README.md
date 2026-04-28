# Message in a Blobble

Demo app for the BAM protocol. Connect your wallet, write a message, sign it with ECDSA, and post it on-chain as an EIP-4844 blob on Sepolia.

## How It Works

1. **Connect** your wallet on Sepolia
2. **Write** a message (280 char limit) and **sign** it (EIP-191 `personal_sign`)
3. **Submit** — the demo forwards the signed message to a separately-running [`@bam/poster`](../../packages/bam-poster) service, which runs validation + pending-pool + batching + L1 submission
4. **Post Blobble** — `@bam/poster` assembles blobs and submits type-3 transactions to BAM Core; the demo's `/api/post-blobble` is a thin proxy that nudges the Poster's per-tag flush endpoint
5. **Confirm** — a separately-running [`bam-reader`](../../packages/bam-reader) tails L1 for `BlobBatchRegistered` events, decodes the blobs, verifies signatures, and writes confirmed rows into the shared `bam-store` substrate. The demo's `/api/confirmed-messages` and `/api/blobbles*` routes proxy to the Reader's HTTP surface
6. **Decode** — the demo no longer fetches or decodes blobs in-process; the Reader serves the L1-derived view

## Architecture — three processes

The Poster and the Reader are both **long-lived Node services**:
- The Poster runs a submission loop and a reorg watcher.
- The Reader runs a live-tail loop scanning L1 for `BlobBatchRegistered` events, plus a small read-only HTTP server.

Both are incompatible with Vercel's serverless model. The demo runs on Vercel and proxies every backend-facing API call to one of them: the Poster (`POSTER_URL`) for the pending/submission surface, the Reader (`READER_URL`) for the confirmed/batch surface.

- **This app** (`message-in-a-blobble`): Next.js, served on Vercel or any Node host. API routes are thin HTTP proxies — no `bam-store` handle, no in-process database, no L1 RPC calls.
- **The Poster** (`@bam/poster`): long-running process. Owns the pending pool, the per-tag submission loops, and the signer key. Default port `:8787`.
- **The Reader** (`bam-reader`): long-running process. Owns the L1-tailing loop and writes confirmed rows into `bam-store`. Exposes a read-only HTTP surface on `:8788` (`/health`, `/messages`, `/batches`, `/batches/:txHash`).
- **`POSTER_URL`** / **`READER_URL`** — set at runtime. Default to `http://localhost:8787` / `http://localhost:8788` for local dev; set to your deployed services' URLs in production.

## Setup

Local development — run all three processes with one command:

```bash
# From workspace root
pnpm install
pnpm --filter bam-sdk build

# Bring up local Postgres for bam-store (Poster + Reader share it)
pnpm db:up

# Configure env for the Poster + Reader (workspace root)
cp .env.local.example .env.local
# Edit .env.local with Sepolia RPC, signer private key, and READER_DB_URL / READER_RPC_URL / READER_BEACON_URL

# Configure env for the demo (Next.js app)
cp apps/message-in-a-blobble/.env.local.example apps/message-in-a-blobble/.env.local
# Edit .env.local with Sepolia RPC, WalletConnect project ID, POSTER_URL, READER_URL

# Run the Poster + Reader + demo concurrently
pnpm dev
```

Or run each process on its own:

```bash
pnpm dev:poster                           # Poster on :8787
pnpm dev:reader                           # Reader on :8788
pnpm --filter message-in-a-blobble dev    # Next.js on :3000
```

**Two env files on purpose:**
- **`.env.local` at the workspace root** — consumed by the `@bam/poster` and `bam-reader` Node services. Each process walks up from its cwd looking for `.env.local` (preferred) or `.env`. Template in `.env.local.example`.
- **`apps/message-in-a-blobble/.env.local`** — consumed by Next.js (`NEXT_PUBLIC_*` for the browser bundle, plus `POSTER_URL` / `READER_URL` for the API routes). Template in `apps/message-in-a-blobble/.env.local.example`.

Different processes, different owners. Backend-process vars stay in the root file; the demo's URL/public vars stay in the app file.

### Environment Variables (demo)

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_RPC_URL` | Sepolia execution RPC (Alchemy/Infura) — used by the browser bundle (e.g. wallet RPC) |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | WalletConnect project ID for RainbowKit |
| `POSTER_URL` | URL of a running `@bam/poster` instance (default `http://localhost:8787`) |
| `READER_URL` | URL of a running `bam-reader` instance (default `http://localhost:8788`) |
| `READER_TIMEOUT_MS` | Per-request timeout for proxying to the Reader (default `8000`) |

### Production deployment notes

**Vercel does not host the Poster or the Reader.** Deploy this Next.js app to Vercel as before; deploy `@bam/poster` and `bam-reader` to a host that supports long-running processes (Docker/Fly/EC2/VPS); set `POSTER_URL` and `READER_URL` on the Vercel deployment to the corresponding public URLs.

- **Poster deploy:** long-running Node process, needs the Sepolia signer key and a `bam-store` database (real Postgres in prod). Listens on `:8787` by default.
- **Reader deploy:** long-running Node process, needs network access to a Sepolia execution RPC and a Beacon API endpoint, plus a `bam-store` database (`READER_DB_URL`, real Postgres in prod) and a stable URL the demo can reach via `READER_URL`. Listens on `:8788` by default and binds to `127.0.0.1` unless `READER_HTTP_BIND` is overridden — front it with a reverse proxy + auth before exposing publicly.

## API Routes

| Route | Method | Proxies to |
|-------|--------|------------|
| `/api/messages` | GET | Poster `GET /pending` (filtered to the `message-in-a-blobble` content tag) |
| `/api/messages` | POST | Poster `POST /submit` |
| `/api/post-blobble` | POST | Poster `POST /flush?contentTag=…` |
| `/api/poster-status` | GET | Poster `GET /status` |
| `/api/poster-health` | GET | Poster `GET /health` |
| `/api/submitted-batches` | GET | Poster `GET /submitted-batches` |
| `/api/confirmed-messages` | GET | Reader `GET /messages?contentTag=…&status=confirmed` |
| `/api/blobbles` | GET | Reader `GET /batches?contentTag=…&status=confirmed` |
| `/api/blobbles/[txHash]` | GET | Reader `GET /batches/:txHash` |

## Stack

- **Next.js 15** (App Router), **Tailwind CSS**
- **RainbowKit + wagmi** — wallet connection
- **React Query** — data fetching
- **bam-sdk** — encoding, signatures, KZG (browser entrypoint for client)
- **viem** — EIP-4844 blob transactions (composer side)

## License

MIT
