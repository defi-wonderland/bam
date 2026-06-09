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

### HTTP read API

```
GET /batches?contentTag=<bytes32>[&status=<batchStatus>][&limit=<n>][&since=<unixSec>]
```

Query params:

```
?contentTag=<bytes32>  Required. Filters batches to a single tag.
?status=<batchStatus>  Optional. One of `pending_tx`, `confirmed`, `reorged`.
?limit=<n>             Optional. 1..1000 (default unbounded up to the store cap).
?since=<unixSec>       Inclusive lower bound on l1IncludedAtUnixSec. Batches with a
                       NULL inclusion time (pre-Reader-fill artifacts) are excluded.
```

### Blob archive (optional)

When `READER_BLOB_ARCHIVE_DIR` is set, the multi-source fetcher reads
from a local directory (keyed by versioned hash) before going to
beacon/Blobscan, and writes successful network fetches back. Archived
blobs are exposed via `GET /blobs/:versionedHash` as
`application/octet-stream` (131072 bytes); 404 when not in the archive
or no archive is configured. The substrate is pluggable — supply a
custom `BlobArchive` via `createReader({...}, { archive })` to back it
with S3 or DB-resident bytea without touching the env.

### Rewinding / starting over

Reader state lives entirely in the `bam-store` substrate, keyed by
`chainId`:

- `reader_cursor` — the singleton `{lastBlockNumber, lastTxIndex}`
  resume point consulted on every `serve` / `--catchup` tick.
- `batches` and `messages` — observed `BatchRow` / `MessageRow` data,
  filterable by `chain_id`.

All row writes go through idempotent upserts (`upsertBatch`,
`upsertObserved`), so re-processing a range is safe — the second pass
just refreshes the same rows. Unreachable blobs (beacon retention is
~18 days; older payloads depend on Blobscan as a fallback) surface as
`counters.undecodable`; a re-pass will retry them. The per-batch
upserts and the subsequent cursor advance land in separate `withTxn`
calls today, so a crash between the last batch and the cursor write
will leave durable rows under a stale cursor — the idempotent-upsert
invariant means the next run reprocesses them safely. When
`READER_BLOB_ARCHIVE_DIR` is set, re-running a range also populates
the archive for previously-observed batches — `archive.put` fires on
every successful network fetch.

**`backfill --from N --to M` rewinds the cursor as a side effect.**
`setCursor` is an unconditional upsert with no monotonicity guard, so
running a finite backfill against a far-ahead reader will push the
cursor back to `M` and trigger a full re-scan on the next `serve`.
This is useful as an ad-hoc rewind tool; it's a footgun if you run it
without realizing the cursor is already past `M`.

**Targeted resets.** For operator-driven rewinds, use the `reset`
subcommand against the configured `READER_CHAIN_ID`:

```
bam-reader reset --cursor --yes   # drop reader_cursor only
bam-reader reset --all    --yes   # also drop batches + messages
```

`--yes` is required; without it the command prints what it would
delete and exits non-zero. `reset` is a pure DB operation — it does
not contact the RPC and does not touch the blob archive directory
(content-addressed; clear it separately with
`rm -rf -- "${READER_BLOB_ARCHIVE_DIR:?READER_BLOB_ARCHIVE_DIR not set}"`
if desired — double-check the value before running).

**Full blank slate.** To wipe the entire substrate, either
`TRUNCATE reader_cursor, batches, messages` against the configured
Postgres, or delete the in-process PGLite DSN file (when
`READER_DB_URL=memory:`, no on-disk file exists — restart the
process). Then re-run `backfill`.
