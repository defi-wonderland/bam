# Message in a Blobble

Demo app for the BAM protocol. Connect your wallet, write a message, sign it with ECDSA, and post it on-chain as an EIP-4844 blob on Sepolia.

## How It Works

1. **Connect** your wallet on Sepolia
2. **Write** a message (280 char limit) and **sign** it (EIP-191 `personal_sign`)
3. **Submit** — validated server-side with `verifyECDSA` and stored in the database
4. **Post Blobble** — pending messages are batch-encoded into an EIP-4844 blob and submitted on-chain (rate-limited to once per minute)
5. **Decode** — blob data is fetched via Beacon API (or Blobscan fallback) and decoded back into messages
6. **Sync** — on-chain blobbles missing from the database can be detected and backfilled, allowing a fresh database to bootstrap from chain state

## Setup

```bash
# From workspace root
pnpm install
pnpm --filter bam-sdk build

# Configure environment
cp apps/message-in-a-blobble/.env.local.example apps/message-in-a-blobble/.env.local
# Edit .env.local with your values

# Run
pnpm --filter message-in-a-blobble dev
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_RPC_URL` | Sepolia execution RPC (Alchemy/Infura) |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | WalletConnect project ID for RainbowKit |
| `POSTER_PRIVATE_KEY` | Server wallet private key (fund with Sepolia ETH) |
| `BEACON_API_URL` | Beacon chain API for blob retrieval |
| `POSTGRES_URL` | Postgres connection string (uses SQLite locally when unset) |

## API Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/api/messages` | GET | List messages, filter by `?status=pending` |
| `/api/messages` | POST | Validate signature, store message |
| `/api/post-blobble` | POST | Batch-encode → blob tx → register on-chain |
| `/api/poster-status` | GET | Signer address, balance, cooldown status |
| `/api/blobbles` | GET | Query `BlobRegistered` events from contract logs |
| `/api/blobbles/[txHash]` | GET | Fetch and decode blob data |
| `/api/sync` | GET | Report on-chain vs DB discrepancies |
| `/api/sync` | POST | Backfill missing blobbles and messages |

## Stack

- **Next.js 15** (App Router), **Tailwind CSS**
- **RainbowKit + wagmi** — wallet connection
- **React Query** — data fetching
- **bam-sdk** — encoding, signatures, KZG (browser entrypoint for client)
- **viem** — EIP-4844 blob transactions
- **better-sqlite3** / **Vercel Postgres** — storage

## License

MIT
