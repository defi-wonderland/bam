# bam-indexer — BAM Twitter Pipeline (TypeScript reference)

Fetches the bam-twitter timeline directly from Ethereum (Sepolia) — no Reader or Postgres needed. Serves as the reference implementation for the ZK coprocessor in `apps/bam-sp1`.

## What it does

1. Queries Blobscan for blob transactions to BAMCore (`0xAC01D2d2...`)
2. Fetches `eth_getTransactionReceipt` per tx to parse `BlobBatchRegistered` + `BlobSegmentDeclared` events
3. Downloads raw blob bytes from Blobscan for each versioned hash
4. `extractSegmentBytes` → `decodeBatch` → `decodeTwitterContents`
5. Sorts by canonical chain order `(blockNumber, txIndex, messageIndexWithinBatch)`
6. Deduplicates by `(sender, nonce)` first-seen
7. Computes timeline root `R = sha256(ordered tweet records)`

## Running

```bash
# First run — fetches from Alchemy + Blobscan, saves cache/batches.json
RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY pnpm start

# Subsequent runs — loads from cache, zero API calls
pnpm start
```

The cache is at `cache/batches.json` (gitignored). Delete it to force a refresh.

## Output

```
Timeline root R: 0x30126f1c725b81fd92348c92ff15a8017585329cfde6d43e07ed0f178f20e2a5

Public inputs for the ZK proof:
  R = 0x30126f1c...
  (C₁…Cₙ = versioned hashes from BlobBatchRegistered events on L1)
```

## Architecture note

This indexer goes directly to the chain source (Sepolia RPC + Blobscan) rather than trusting the bam-reader service. This matters for ZK: the proof is only meaningful if the input data comes from a verifiable source. Blobscan is still a trust assumption (Phase 4 fixes this with KZG verification inside the SP1 circuit).

The `READER_URL` path (`buildTimeline`) is kept for testing against a local stack but is not the correct data source for proving.
