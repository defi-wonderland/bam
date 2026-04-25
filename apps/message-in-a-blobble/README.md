# Message in a Blobble

Demo app for the BAM protocol. Connect your wallet, write a message, sign it with ECDSA, and post it on-chain as an EIP-4844 blob on Sepolia.

## How It Works

1. **Connect** your wallet on Sepolia
2. **Write** a message (280 char limit) and **sign** it (EIP-191 `personal_sign`)
3. **Submit** — the demo forwards the signed message to a separately-running [`@bam/poster`](../../packages/bam-poster) service, which runs validation + pending-pool + batching + L1 submission
4. **Post Blobble** — `@bam/poster` assembles blobs and submits type-3 transactions to BAM Core; the demo's `/api/post-blobble` is a thin proxy that nudges the Poster's per-tag flush endpoint
5. **Decode** — blob data is fetched via Beacon API (or Blobscan fallback) and decoded back into messages
6. **Sync** — on-chain blobbles missing from the database can be detected and backfilled, allowing a fresh database to bootstrap from chain state

## Architecture — two processes

The Poster is a **long-lived Node service** (it runs a submission loop and a reorg watcher, which is incompatible with Vercel's serverless model). This demo app runs on Vercel and proxies every Poster-facing API call to `POSTER_URL`.

- **This app** (`message-in-a-blobble`): Next.js on Vercel. API routes `/api/messages`, `/api/post-blobble`, `/api/poster-status`, `/api/poster-health`, and `/api/submitted-batches` are thin HTTP proxies that forward verbatim to `POSTER_URL`.
- **The Poster** (`@bam/poster`): deployed separately as a long-running process (Docker/Fly/EC2/VPS). It owns the pending pool, the per-tag submission loops, and the signer key.
- **`POSTER_URL`** — the demo reads this env var at runtime. Set to `http://localhost:8787` for local dev; to your deployed Poster's URL in production.

## Setup

Local development — run both processes with one command:

```bash
# From workspace root
pnpm install
pnpm --filter bam-sdk build

# Configure env for the Poster (workspace root)
cp .env.local.example .env.local
# Edit .env.local with Sepolia RPC + signer private key

# Configure env for the demo (Next.js app)
cp apps/message-in-a-blobble/.env.local.example apps/message-in-a-blobble/.env.local
# Edit .env.local with Sepolia RPC + WalletConnect project ID

# Run the Poster + demo concurrently
pnpm dev
```

Or run each process on its own:

```bash
pnpm dev:poster                           # Poster on PORT=8787
pnpm --filter message-in-a-blobble dev    # Next.js on :3000
```

**Two env files on purpose:**
- **`.env.local` at the workspace root** — consumed by the `@bam/poster` Node service. The Poster's CLI walks up from its cwd looking for `.env.local` (preferred) or `.env`. Template in `.env.local.example`.
- **`apps/message-in-a-blobble/.env.local`** — consumed by Next.js (`NEXT_PUBLIC_*` for the browser bundle, plus `POSTER_URL` + `BEACON_API_URL` for the API routes). Template in `apps/message-in-a-blobble/.env.local.example`.

Different processes, different owners. The Poster's vars (`POSTER_*`) only matter in the root file; the demo's vars (`NEXT_PUBLIC_*`, `POSTER_URL`) only in the app file.

### Environment Variables (demo)

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_RPC_URL` | Sepolia execution RPC (Alchemy/Infura) — used by `/api/blobbles` to query on-chain logs |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | WalletConnect project ID for RainbowKit |
| `POSTER_URL` | URL of a running `@bam/poster` instance (default `http://localhost:8787`) |
| `POSTER_SIGNER_PRIVATE_KEY` | Poster signer private key — consumed by the separate `@bam/poster` process, **not** by this demo or Vercel. Listed here so a local `.env.local` is self-contained when running `pnpm dev`. |
| `BEACON_API_URL` | Beacon chain API for blob retrieval (used by `/api/blobbles/[txHash]` for third-party blob verification) |

### Production deployment note

**Vercel does not host the Poster.** Deploy this Next.js app to Vercel as before; deploy `@bam/poster` to a host that supports long-running processes (Docker/Fly/EC2/VPS); set `POSTER_URL` on the Vercel deployment to your Poster's public URL.

## API Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/api/messages` | GET | Proxies to Poster `GET /pending` (filtered to the `message-in-a-blobble` content tag) |
| `/api/messages` | POST | Wraps body in the Poster envelope, proxies to `POST /submit`, returns the Poster's response verbatim |
| `/api/post-blobble` | POST | Proxies to Poster `POST /flush?contentTag=…` (nudges an immediate submission tick) |
| `/api/poster-status` | GET | Proxies to Poster `GET /status` |
| `/api/poster-health` | GET | Proxies to Poster `GET /health` |
| `/api/submitted-batches` | GET | Proxies to Poster `GET /submitted-batches` |
| `/api/confirmed-messages` | GET | Flattens decoded messages out of Poster's submitted batches (source of truth for the "Posted" view) |
| `/api/blobbles` | GET | Query `BlobBatchRegistered` events from BAM Core, filtered by content tag |
| `/api/blobbles/[txHash]` | GET | Fetch a blob from the beacon API and decode it independently — third-party verification path |

## Stack

- **Next.js 15** (App Router), **Tailwind CSS**
- **RainbowKit + wagmi** — wallet connection
- **React Query** — data fetching
- **bam-sdk** — encoding, signatures, KZG (browser entrypoint for client)
- **viem** — on-chain reads (blob tx submission lives in `@bam/poster`)
- **`@bam/poster`** — separately-deployed Node service that owns the pending pool, signer, and submission loop

## License

MIT
