# @bam/poster

Node-only library + HTTP service + CLI that batches ingested BAM messages
and submits them to L1 as blob batches via the existing BAM Core
`registerBlobBatch` entrypoint.

Feature spec: [`docs/specs/features/001-bam-poster`](../../docs/specs/features/001-bam-poster/spec.md).

## Scope

- **Library surface** — `createPoster(config)` returns an object with
  `submit`, `listPending`, `listSubmittedBatches`, `status`, `health`,
  `start`, and `stop`.
- **HTTP transport** — thin adapter exposing the library surface over
  JSON endpoints.
- **CLI entrypoint** — `bam-poster` binary that reads env, wires the
  library, mounts HTTP, handles SIGTERM.

This package is **Node-only** — it imports `better-sqlite3`, `c-kzg`,
and `node:http` at the top level. Do not import it from
`bam-sdk/browser` or any other browser-reachable code.

## Non-goals

- Vercel serverless deployment. The submission loop, reorg watcher, and
  backoff state require a long-lived process.
- Cross-Poster coordination. A single Poster is the unit of scope.
- Multi-segment (ERC-8179) blob packing. v1 submits one content tag per
  blob, full range `[0, 4096)`; the seam is preserved.
