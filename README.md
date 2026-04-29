# BAM — Blob Authenticated Messaging

A reference implementation of the BAM protocol for authenticated messaging over EIP-4844 blobs.
Built by [Wonderland](https://wonderland.xyz).

> **Warning:** Experimental software under active development. APIs, wire formats, and
> contract interfaces may change without notice. Not audited — do not use in production.

## Packages

| Package | Description |
|---------|-------------|
| [`bam-sdk`](packages/bam-sdk) | TypeScript SDK — message/batch encoding, BPE compression, Zstd decompression, BLS/ECDSA signatures, KZG proofs, blob exposure. Browser entrypoint at `bam-sdk/browser`. |
| [`bam-cli`](packages/bam-cli) | CLI — key management, message encoding, batch operations, BLS aggregation |
| [`bam-contracts`](packages/bam-contracts) | Solidity — BlobAuthenticatedMessagingCore, BLSRegistry, BLSExposer, verifiers (Foundry) |

## Apps

| App | Description |
|-----|-------------|
| [`message-in-a-blobble`](apps/message-in-a-blobble) | Demo — sign messages with ECDSA, batch-encode, and post as EIP-4844 blobs on Sepolia |
| [`exposure-demo`](apps/exposure-demo) | Demo — full on-chain exposure lifecycle: BLS key registration, blob posting, KZG proof generation, and message exposure via BLSExposer |

## Getting Started

```bash
pnpm install
cd packages/bam-contracts && forge install
pnpm -r build
pnpm -r test:run
```

### Requirements

- Node.js >= 20, pnpm >= 10
- [Foundry](https://book.getfoundry.sh/getting-started/installation) (contracts)
- C compiler (gcc/clang) for `c-kzg` native module

## Running the stack

The Poster and Reader services run side-by-side with Postgres in a single
"fat" container so demos can target one host for ingest, query, and DB
inspection.

### Local (docker-compose)

```bash
cp .env.docker.example .env.local        # fill POSTER_*/READER_* values
pnpm stack:up                             # build + start
pnpm stack:logs                           # tail
pnpm stack:down                           # stop (state preserved)
pnpm stack:reset                          # stop + drop the volume
```

Published on the loopback only:

| Port | Service |
|------|---------|
| `127.0.0.1:5432` | Postgres (`postgres://postgres:postgres@127.0.0.1:5432/bam`) |
| `127.0.0.1:8787` | bam-poster HTTP |
| `127.0.0.1:8788` | bam-reader HTTP |

`pnpm db:up` / `db:down` / `db:reset` remain as aliases for the same stack.

### Production (fly.io)

`fly.toml` deploys the same image with Postgres bound to localhost inside
the machine — only `8787` and `8788` are exposed externally. Postgres data
lives on a fly volume mounted at `/var/lib/postgresql/data`.

```bash
fly apps create <app-name>
fly volumes create bam_data --region <region> --size 10
fly secrets set POSTER_ALLOWED_TAGS=… POSTER_CHAIN_ID=… POSTER_BAM_CORE_ADDRESS=… \
                POSTER_RPC_URL=… POSTER_SIGNER_PRIVATE_KEY=… \
                READER_CHAIN_ID=… READER_RPC_URL=… READER_BAM_CORE=…
fly deploy
```

The image is defined in [`Dockerfile`](Dockerfile); the supervisor that
brings up Postgres → poster → reader lives in
[`docker/entrypoint.sh`](docker/entrypoint.sh).

## Architecture

```
bam-sdk                              bam-contracts
├── Protocol layer                   ├── core/
│   ├── types, constants, errors     │   ├── BlobAuthenticatedMessagingCore
│   ├── message encoding             │   ├── SocialBlobsCore
│   ├── batch encoding               │   ├── BLSRegistry
│   ├── compression (bpe + zstd dec) │   └── BlobSpaceSegments
│   └── BLS + ECDSA signatures       ├── exposers/
├── On-chain layer                   │   └── BLSExposer
│   ├── KZG proof generation         ├── verifiers/
│   ├── blob parsing + exposure      │   └── SimpleBoolVerifier
│   └── viem contract client         ├── libraries/
├── Browser entrypoint               │   ├── BLSVerifier, KZGVerifier
│   └── bam-sdk/browser (no c-kzg,  │   └── BLS12381, BLSDecompression
│       no node:fs/crypto)           └── interfaces/
└── Aggregator client                    ├── IERC_BAM_*
                                         └── IERC_BSS_*
```

Contract ABIs in the SDK are auto-generated from Foundry output:

```bash
pnpm sync:abis   # forge build + generate packages/bam-sdk/src/contracts/abis.ts
```

## Deployments

Addresses are tracked in `packages/bam-contracts/deployments/<chainId>.json` and synced into the SDK.

```bash
cd packages/bam-contracts
forge script script/Deploy.s.sol:DeployTestnet --rpc-url $SEPOLIA_RPC_URL --broadcast
cd ../..
pnpm deploy:save Deploy.s.sol 11155111
```

```typescript
import { getDeployment } from 'bam-sdk';
const sepolia = getDeployment(11155111);
```

## Specs

- [ERC-8180: Blob Authenticated Messaging](docs/specs/erc-8180.md)
- [ERC-8179: Blob Space Segments](docs/specs/erc-8179.md)

## Key Features

- **Compression** — BPE codec for encoding; Zstd decompression with trained dictionary (compression is stubbed, pending full zstd bindings)
- **BLS signature aggregation** — N signatures → 1
- **ECDSA support** — compatible with existing Ethereum wallets
- **KZG proofs** — extract and prove individual messages from blobs
- **Stateless contracts** — events only, no storage reads
- **ERC-BAM compliant** — standardized decoder discovery and message exposure

## License

MIT
