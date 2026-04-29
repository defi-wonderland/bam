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
