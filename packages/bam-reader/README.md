## bam-reader

Node-only service that scans L1 for `BlobBatchRegistered` events,
fetches blob bytes (beacon API primary, Blobscan fallback), recomputes
the versioned hash on every source, dispatches decode and per-message
signature verification (zero-address shortcut to the SDK; non-zero →
bounded `eth_call` to the named contract), and persists the resulting
`BatchRow`/`MessageRow` values into the shared `bam-store` substrate.
A separate reorg-watcher loop reconciles in-window confirmed batches
against the canonical chain. Two operating modes: `serve` (live-tail
daemon) and `backfill --from N --to M` (one-shot historical run).
