# @bam/poster

Node-only library + HTTP service + CLI that batches ingested BAM messages
and submits them to L1 as packed blob batches via the BAM Core's
`registerBlobBatches` entrypoint. A cross-tag aggregator pools every
allowlisted tag's pending pool into one type-3 transaction per round,
laying per-tag segments at FE-aligned offsets within a single 4844 blob.

## Scope

- **Library surface** — `createPoster(config, { buildAndSubmitMulti, rpc })`
  returns an object with `submit`, `listPending`, `listSubmittedBatches`,
  `status`, `health`, `start`, and `stop`.
- **HTTP transport** — thin adapter exposing the library surface over
  JSON endpoints.
- **CLI entrypoint** — `bam-poster` binary that reads env, wires the
  library, mounts HTTP, handles SIGTERM.

This package is **Node-only** — it reaches `c-kzg` and `node:http`
at the top level, plus `bam-store`'s Node-only Postgres adapter
through `createDbStore`. Do not import it from `bam-sdk/browser` or
any other browser-reachable code.

## Multi-tag blob packing

The aggregator (`AggregatorLoop`) is the single submission path:

1. Snapshot every allowlisted tag's pending pool.
2. Run each tag's `BatchPolicy.select`. If no tag fired, the tick is a no-op.
3. Build a `PackPlan` (`planPack`) — oldest-first arbitration, FE-aligned offsets.
4. Assemble the multi-segment blob via `bam-sdk`'s `assembleMultiSegmentBlob`.
5. Run the producer-side runtime self-check (`verifyPackedBlobRoundTrips`)
   to catch FE-alignment / encoding bugs *before* broadcast.
6. Submit one type-3 tx calling `registerBlobBatches([{...}, ...])`. Atomicity
   falls out of the contract design — every per-tag event lands together
   or the whole tx reverts.
7. On confirmation, write one `BatchRow` per included tag in a single
   `withTxn`. Excluded tags' `packingLossStreak` increments; included
   tags reset to 0.

Single-tag rounds are just a one-element `BlobBatchCall[]` array — there
is no separate `registerBlobBatch` codepath in the Poster after
006-blob-packing-multi-tag.

The operator-visible `/health` surface exposes per-tag
`{ pendingCount, packingLossStreak, lastIncludedAt, warn }` plus
aggregator-level `{ lastPackedTxHash, lastPackedTagCount,
permanentlyStopped }`. The `warn` flag flips when a tag's streak
crosses `POSTER_PACKING_LOSS_STREAK_WARN_THRESHOLD` (default 10).

## Non-goals

- Vercel serverless deployment. The submission loop, reorg watcher, and
  backoff state require a long-lived process.
- Cross-Poster coordination. A single Poster is the unit of scope.
- Automatic starvation backstop for tags that always lose oldest-first
  arbitration. The packing-loss-streak counter is detection-only;
  remediation is operator-driven (scale up the Poster or accept the
  latency).
