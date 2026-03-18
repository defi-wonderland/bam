# Message in a Blobble

Example app for the BAM protocol, built by [Wonderland](https://wonderland.xyz). Connect your
wallet, write a message, sign it with ECDSA, and post it on-chain as a real EIP-4844 blob on
Sepolia. Decode blobs back from the chain to read messages.

## How It Works

1. **Connect** your wallet (MetaMask, WalletConnect, etc.) on Sepolia
2. **Write** a message (280 character limit)
3. **Sign** — the app computes a BAM message hash and asks your wallet to sign it (EIP-191 `personal_sign`)
4. **Submit** — the signed message is validated server-side with `verifyECDSA` and stored in SQLite
5. **Post Blobble** — all pending messages are batch-encoded, packed into an EIP-4844 blob, and submitted on-chain via a server wallet (rate-limited to once per minute)
6. **View on-chain** — `BlobRegistered` events are queried from `SocialBlobsCore` to list posted blobbles
7. **Decode blob** — blob data is fetched via the Beacon API (or Blobscan fallback) and decoded back into messages using `decodeBatch`
8. **Sync** — the app detects on-chain blobbles missing from the database and can sync them back, decoding blob data and inserting messages. This allows bootstrapping a fresh database from on-chain state

The blob transaction is registered with the `SocialBlobsCore` contract on Sepolia (`0x11a825a0774d0471292eab4706743bffcdd5d137`).

## Stack

- **Next.js 15** (App Router)
- **RainbowKit + wagmi** for wallet connection
- **React Query** for data fetching and cache invalidation
- **bam-sdk/browser** for client-side message hashing
- **bam-sdk** (full) for server-side signature verification, batch encoding, and KZG
- **better-sqlite3** (local) / **Vercel Postgres** (deployed) for persistent message storage
- **viem** for EIP-4844 blob transactions
- **Tailwind CSS** with a desert island theme

## Setup

```bash
# From workspace root
pnpm install
pnpm --filter bam-sdk build

# Configure environment
cp apps/message-in-a-blobble/.env.local.example apps/message-in-a-blobble/.env.local
# Edit .env.local with your values
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_RPC_URL` | Sepolia execution RPC (Alchemy/Infura) |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | WalletConnect project ID for RainbowKit |
| `POSTER_PRIVATE_KEY` | Private key for the server wallet that pays for blob transactions (fund with Sepolia ETH) |
| `BEACON_API_URL` | Beacon chain API for blob retrieval (e.g. `https://eth-sepoliabeacon.g.alchemy.com/v2/KEY`) |
| `POSTGRES_URL` | Postgres connection string (auto-set by Vercel Postgres — uses SQLite locally when unset) |

### Run

```bash
pnpm --filter message-in-a-blobble dev
# Open http://localhost:3000
```

## Architecture

```
Client (browser)                     Server (Next.js API routes)
─────────────────                    ──────────────────────────
bam-sdk/browser                      bam-sdk (full)
  computeMessageHash()                 verifyECDSA()
  → wallet signMessage()               computeMessageId()
  → POST /api/messages                 encodeBatch() / decodeBatch()
                                       createBlob() + commitToBlob()
                                       viem blob tx → Sepolia
                                     better-sqlite3 / Vercel Postgres
                                       messages + blobbles tables
                                     Beacon API / Blobscan
                                       fetch + decode blob data
                                     Sync (POST /api/sync)
                                       compare on-chain logs ↔ DB
                                       backfill missing blobbles
```

### API Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/api/messages` | GET | List messages, optionally filter by `?status=pending` |
| `/api/messages` | POST | Validate ECDSA signature and store message in SQLite |
| `/api/post-blobble` | POST | Batch-encode pending messages → blob tx → register on-chain (rate-limited to once per minute) |
| `/api/poster-status` | GET | Signer address, ETH balance, cooldown status, and last post time |
| `/api/blobbles` | GET | Query `BlobRegistered` events from SocialBlobsCore |
| `/api/blobbles/[txHash]` | GET | Fetch blob data via Beacon API / Blobscan, decode messages |
| `/api/sync` | GET | Compare on-chain blobbles against the database and report missing entries |
| `/api/sync` | POST | Fetch and decode missing blobs, insert blobble and message records into the database |

## License

MIT
