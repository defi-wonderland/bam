# BAM Exposure Demo

Full-lifecycle demo of BAM on-chain message exposure: register a BLS key, compose and sign messages, post them in EIP-4844 blobs, then cryptographically prove individual messages on-chain via KZG proofs and BLS signature verification.

## Flow

1. **Connect wallet** — Sepolia via RainbowKit
2. **Register BLS key** — generate BLS12-381 keypair, register on `BLSRegistry` with proof-of-possession
3. **Compose message** — sign with your BLS key (client-side)
4. **Post blob** — server encodes an exposure batch, creates an EIP-4844 blob, calls `SocialBlobsCore.registerBlob()`
5. **Browse & decode** — list registered blobs, fetch blob data via Beacon API / Blobscan, decode messages
6. **Expose on-chain** — server builds KZG proofs via `parseBlob()` + `buildExposureParams()`, client submits `BLSExposer.expose()` transaction
7. **View history** — browse `MessageExposed` events

## Architecture

- **Client-side**: BLS key management (localStorage), message signing, transaction submission via wagmi
- **Server-side**: SQLite storage, exposure batch encoding (`encodeExposureBatch`), blob posting (EIP-4844), KZG proof generation (`parseBlob` + `buildExposureParams` — Node-only via c-kzg)

Messages are encoded in **exposure batch format** (`SOB2`) where each message is stored in on-chain raw format `[author(20)][timestamp(4)][nonce(2)][content]`. This makes individual messages directly KZG-addressable — the bytes extracted by KZG proofs match exactly what the `BLSExposer` contract verifies.

## Setup

```bash
# From workspace root
pnpm install
pnpm -r build

# Configure environment
cp apps/exposure-demo/.env.local.example apps/exposure-demo/.env.local
# Edit .env.local — set NEXT_PUBLIC_RPC_URL, POSTER_PRIVATE_KEY, etc.

# Run
cd apps/exposure-demo
pnpm dev
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_RPC_URL` | Yes | Sepolia RPC URL (must support EIP-4844 blob transactions) |
| `POSTER_PRIVATE_KEY` | Yes | Private key for server-side blob posting (needs Sepolia ETH) |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | No | WalletConnect project ID |
| `BEACON_API_URL` | No | Beacon API URL for blob fetching (falls back to Blobscan) |

## Contracts (Sepolia)

| Contract | Address |
|----------|---------|
| SocialBlobsCore | `0x11a825a0774d0471292eab4706743bffcdd5d137` |
| SimpleBoolVerifier | `0xdec5faa3e32d6296e53bae7e359e059b58a482f4` |
| BLSRegistry | `0x15866bf5a8724f2aa9fe75e262d8f00ba2818e25` |
| BLSExposer | `0x443029b4b96fbf2d8feba77d828a394d19615a48` |

## License

MIT
