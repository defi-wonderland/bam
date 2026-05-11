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
`counters.undecodable`; a re-pass will retry them. Per-block writes
and cursor advance are atomic.

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
delete and exits non-zero. `reset` does not touch any on-disk
artifacts outside the database — chain-external caches (e.g. a
content-addressed blob archive directory, if configured) must be
cleared separately with `rm -rf`.

**Full blank slate.** To wipe the entire substrate, either
`TRUNCATE reader_cursor, batches, messages` against the configured
Postgres, or delete the in-process PGLite DSN file (when
`READER_DB_URL=memory:`, no on-disk file exists — restart the
process). Then re-run `backfill`.
