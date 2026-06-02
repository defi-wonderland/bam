# bam-blob-calc

Cost calculator for EIP-4844 blobs vs calldata. Paste any text, see live cost estimates for both storage methods using real on-chain fee data.

## How it works

1. Type or paste text into the input field.
2. The page fetches live `baseFee` and `blobBaseFee` data from a Sepolia/mainnet RPC via `eth_feeHistory`.
3. Costs for blob storage and equivalent calldata are computed client-side using the current fee snapshot, displayed in ETH, Gwei, and USD.
4. Toggle between **latest** (single block) and **average** (20-block window) fee modes.

The server-side `/api/fees` route fetches fee history and ETH/USD price; the rest is pure client math.

## Run

```bash
pnpm --filter bam-blob-calc dev
# → http://localhost:3004
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `RPC_URL` | `https://ethereum-rpc.publicnode.com` | Ethereum mainnet JSON-RPC endpoint for `eth_feeHistory` |
| `FEE_HISTORY_BLOCKS` | `20` | Number of recent blocks to average for the fee panel |

Both are optional — the app works out of the box without any configuration.

## Stack

- **Next.js 15** (App Router)
- **Tailwind CSS**

## Live

https://bam-blob-calc.vercel.app

## License

MIT
