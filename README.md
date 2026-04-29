# BAM — Blob Authenticated Messaging

A reference implementation of the BAM protocol for authenticated messaging over EIP-4844 blobs.
Built by [Wonderland](https://wonderland.xyz).

> **Warning:** Experimental software under active development. APIs, wire formats, and
> contract interfaces may change without notice. Not audited — do not use in production.

## Packages

| Package | Description |
|---------|-------------|
| [`bam-sdk`](packages/bam-sdk) | TypeScript SDK — message/batch encoding, BPE compression, Zstd decompression, BLS/ECDSA signatures, KZG proofs, blob exposure. Browser entrypoint at `bam-sdk/browser`. |
| [`bam-poster`](packages/bam-poster) | Node library + HTTP service + CLI — ingests signed messages, batches them, and submits EIP-4844 blob transactions to BAM Core |
| [`bam-reader`](packages/bam-reader) | Node service — tails L1 for `BlobBatchRegistered`, fetches blobs (beacon → Blobscan), decodes + verifies signatures, and writes confirmed rows into `bam-store`. Exposes a read-only HTTP surface |
| [`bam-store`](packages/bam-store) | Shared persistence substrate for the Poster and Reader — SQLite/Postgres `BatchRow` / `MessageRow` schema and adapters |
| [`bam-cli`](packages/bam-cli) | CLI — key management, message encoding, batch operations, BLS aggregation |
| [`bam-contracts`](packages/bam-contracts) | Solidity — BlobAuthenticatedMessagingCore, BLSRegistry, ECDSARegistry, SignatureRegistryDispatcher, BLSExposer, verifiers (Foundry) |

## Apps

| App | Description |
|-----|-------------|
| [`message-in-a-blobble`](apps/message-in-a-blobble) | Demo — sign messages with ECDSA in the browser; the app proxies submission to `@bam/poster` and confirmed reads to `bam-reader` |
| [`bam-sdk-test`](apps/bam-sdk-test) | Playground — surfaces the `bam-sdk/browser` API one section at a time (hex, message, ECDSA, BLS, batch, exposure, BPE, compression) |

## Getting Started

```bash
pnpm install
cd packages/bam-contracts && forge install
pnpm -r build
pnpm -r test:run
```

To run the demo end-to-end, bring up Postgres for `bam-store` and start all three processes from the workspace root:

```bash
pnpm db:up   # Postgres for bam-store (Poster + Reader share it)
pnpm dev     # @bam/poster :8787 + bam-reader :8788 + message-in-a-blobble :3000
```

Or run each on its own with `pnpm dev:poster` / `pnpm dev:reader` / `pnpm --filter message-in-a-blobble dev`. See [`apps/message-in-a-blobble/README.md`](apps/message-in-a-blobble/README.md) for env setup.

### Requirements

- Node.js >= 20, pnpm >= 10
- Docker (local Postgres for `bam-store`)
- [Foundry](https://book.getfoundry.sh/getting-started/installation) (contracts)
- C compiler (gcc/clang) for `c-kzg` native module

## Architecture

```
bam-sdk                              bam-contracts
├── Protocol layer                   ├── core/
│   ├── types, constants, errors     │   ├── BlobAuthenticatedMessagingCore
│   ├── message encoding             │   ├── SocialBlobsCore
│   ├── batch encoding               │   ├── BLSRegistry
│   ├── compression (bpe + zstd dec) │   ├── ECDSARegistry
│   └── BLS + ECDSA signatures       │   ├── SignatureRegistryDispatcher
├── On-chain layer                   │   └── BlobSpaceSegments
│   ├── KZG proof generation         ├── exposers/
│   ├── blob parsing + exposure      │   └── BLSExposer
│   └── viem contract client         ├── verifiers/
├── Browser entrypoint               │   └── SimpleBoolVerifier
│   └── bam-sdk/browser (no c-kzg,   ├── libraries/
│       no node:fs/crypto)           │   ├── BLSVerifier, KZGVerifier
└── Aggregator client                │   └── BLS12381, BLSDecompression
                                     └── interfaces/
                                         ├── IERC_BAM_*
                                         └── IERC_BSS_*

bam-poster (Node)                    bam-reader (Node)
├── Ingest — envelope, signed-tag,   ├── Discovery — log-scan + cursor
│   monotonicity, rate-limit         ├── Blob fetch — beacon → Blobscan
├── Pool — bam-store (SQLite/PG)     │   with versioned-hash recompute
├── Submission — type-3 blob tx      ├── Decode + verify — SDK or
│   loop + reorg watcher             │   bounded eth_call to registry
└── HTTP — /submit, /pending,        ├── Reorg watcher
    /flush, /status, /health,        ├── Persistence — bam-store
    /submitted-batches               └── HTTP — /messages, /batches,
                                         /batches/:txHash, /health
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

## Reader operator knobs

The `bam-reader` service ingests historical L1 events and serves
confirmed reads. Most operators don't need to touch any of the env
vars below — the defaults work against the public Sepolia provider
the demo uses. Reach for these when an operator scenario requires it:

- `READER_START_BLOCK` — first-tick block for live-tail when no
  cursor row exists yet. **Defaults to** the BAM Core deploy block
  for the configured chainId (resolved via `bam-sdk`'s
  deployment table). When unset *and* the chainId isn't in the
  table (anvil/hardhat dev chains), the Reader scans from `0` and
  emits a stderr warning naming the chainId.
- `READER_LOG_SCAN_CHUNK_BLOCKS` — `eth_getLogs` chunk size, in
  blocks. **Default: `2000`.** Raise on a private RPC with a
  higher cap so a backfill finishes in fewer round-trips; lower
  on a flaky provider. Adaptive halving handles "range too large"
  / "result too large" automatically — operators on public RPCs
  (Alchemy, Infura) generally don't need to tune this by hand.
- `READER_BACKFILL_PROGRESS_INTERVAL_MS` — minimum wallclock
  interval between `backfill_progress` events. **Default:
  `10_000`** (10 seconds).
- `READER_BACKFILL_PROGRESS_EVERY_CHUNKS` — alternative cadence
  trigger; emits a progress event every N chunks. **Default:
  `5`.** Whichever threshold fires first wins.

The CLI accepts four backfill forms:

```bash
bam-reader backfill --from <block> --to <block>   # explicit range
bam-reader backfill --from deploy [--to <block>]  # from the BAM Core deploy block
bam-reader backfill --catchup                     # [cursor + 1, safe head]
bam-reader serve                                  # long-running live-tail daemon
```

`--from deploy` and `--catchup` are mutually exclusive with each
other and with `--from N --to M`. When `--to` is omitted,
`--from deploy` and `--catchup` default to **safe head**
(`current head − reorgWindowBlocks`). Advancing the cursor past
the reorg window would let a subsequent reorg drop new
`BlobBatchRegistered` logs that live-tail (which resumes at
`cursor + 1`) would never re-scan. Operators who want to backfill
into the reorg window can pass an explicit `--to <block>` — that is
treated as an opt-in.

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
