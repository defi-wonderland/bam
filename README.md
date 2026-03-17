# BAM — Blob Authenticated Messaging

A reference implementation of the BAM protocol for authenticated messaging over EIP-4844 blobs.
Built by [Wonderland](https://wonderland.xyz).

This monorepo contains the reference TypeScript SDK, Solidity smart contracts, CLI, and a demo app.

> **Warning:** This is experimental software under active development. APIs, wire formats, and
> contract interfaces may change without notice. Not audited — do not use in production.

## Packages

| Package | Description |
|---------|-------------|
| [`bam-sdk`](packages/bam-sdk) | TypeScript SDK — message encoding, compression, BLS/ECDSA signatures, KZG proofs, blob exposure, and viem-based contract client. Browser-safe entrypoint at `bam-sdk/browser`. |
| [`bam-cli`](packages/bam-cli) | CLI tool — key management, message encoding, batch operations, BLS aggregation, and aggregator interaction |
| [`bam-contracts`](packages/bam-contracts) | Solidity contracts — BlobAuthenticatedMessagingCore, BLSRegistry, BLSExposer, verifiers, and libraries (Foundry) |

## Apps

| App | Description |
|-----|-------------|
| [`message-in-a-blobble`](apps/message-in-a-blobble) | Demo app — connect wallet, write a message, sign with ECDSA, batch-encode, and post as a real EIP-4844 blob on Sepolia |

## Getting Started

```bash
# Install dependencies
pnpm install

# Install Foundry contract dependencies
cd packages/bam-contracts && forge install

# Build everything
pnpm -r build

# Run tests
pnpm -r test:run                          # SDK unit tests (88)
pnpm --filter bam-sdk test:integration    # SDK integration tests (37)
cd packages/bam-contracts && forge test    # Solidity tests (234)
```

### Requirements

- Node.js >= 20
- pnpm >= 10
- [Foundry](https://book.getfoundry.sh/getting-started/installation) (for contract development)
- C compiler (gcc/clang) for `c-kzg` native module

## Architecture

```
bam-sdk                              bam-contracts
├── Protocol layer                   ├── core/
│   ├── types, constants, errors     │   ├── BlobAuthenticatedMessagingCore
│   ├── message encoding             │   ├── SocialBlobsCore (legacy)
│   ├── batch encoding               │   ├── BLSRegistry
│   ├── zstd compression             │   └── BlobSpaceSegments
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

message-in-a-blobble (demo app)
├── Next.js 15 + Tailwind
├── RainbowKit wallet connect
├── Client: sign messages with bam-sdk/browser
├── Server: verify, store in SQLite, batch-encode
└── Blob posting: EIP-4844 blob tx + SocialBlobsCore registration
```

The SDK has no build-time dependency on the Solidity package. Contract ABIs in the SDK are
auto-generated from Foundry build output:

```bash
pnpm sync:abis   # forge build + generate packages/bam-sdk/src/contracts/abis.ts
```

Run this after changing any Solidity contract interfaces.

## Deployments

Deployed contract addresses are tracked in `packages/bam-contracts/deployments/<chainId>.json`
and synced into the SDK as a typed module.

```bash
# 1. Deploy contracts
cd packages/bam-contracts
forge script script/Deploy.s.sol:DeployTestnet --rpc-url $SEPOLIA_RPC_URL --broadcast

# 2. Save addresses and sync into SDK (one command)
cd ../..
pnpm deploy:save Deploy.s.sol 11155111
```

The SDK exposes a `getDeployment()` helper:

```typescript
import { getDeployment } from 'bam-sdk';

const sepolia = getDeployment(11155111);
console.log(sepolia?.contracts.BLSExposer?.address);
```

## Specs

Protocol specifications live in [`specs/`](specs/):

- [ERC-8180: Blob Authenticated Messaging](specs/erc-blob-authenticated-messaging/erc-draft.md)
- [ERC-8179: Blob Space Segments](specs/erc-shared-blob-segments/erc-draft.md)

## Key Features

- **9.17x compression** via trained Zstd dictionary (bundled in SDK)
- **BLS signature aggregation** — N signatures → 1 for efficient on-chain verification
- **ECDSA support** — compatible with existing Ethereum wallets
- **KZG proofs** — extract and prove individual messages from EIP-4844 blobs
- **Stateless core** — on-chain contracts emit events only, no storage reads
- **ERC-BAM compliant** — standardized interfaces for decoder discovery and message exposure

## About

This is a reference implementation of the BAM protocol, developed by
[Wonderland](https://wonderland.xyz). It is intended as an example and starting point for
building on the protocol — not as a production-ready system.

## License

MIT
