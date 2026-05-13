# Indexer design notes

## Layering

Three roles, three different concerns:

| Layer | What it does | Boundary | This repo |
|---|---|---|---|
| **Protocol indexer** | L1 event scan → blob fetch → decode → signature verify → confirmed messages per `contentTag` | ERC-8180 — protocol-level | `bam-reader` |
| **App indexer** | Typed entities per `contentTag` + on-chain enrichment + multi-consumer query API | Per-app — but app-agnostic in its multi-consumer shape | `bam-indexer` (this layer) |
| **BFF / FE** | App-shaped response shaping, ranking, personalization, auth, pagination policy | Per-FE — knows the consumer | apps/* (Next.js routes today) |

The boundary that earned this whole package: an **indexer** is
*multi-consumer* and *app-agnostic in its data model*. A **BFF**
knows its single FE and bakes that knowledge into response shape.
Both can run in the same process, but conflating them in
architecture is sloppy. The Twitter discussion that produced this
design started from the quote "an indexer which … applies relevant
application logic" — that phrasing is BFF-shaped, not
indexer-shaped, and we kept the layer indexer-shaped by stripping
out the application-logic line.

## Why a second indexer above the Reader

`bam-reader`'s output is `MessageRow` per `contentTag`:
`(sender, nonce, contents, messageHash, batchRef, blockNumber, …)`.
It does NOT:

- Decode the app-specific payload inside `contents` (each app has
  its own codec — Twitter's `version ‖ kind ‖ payload`, Comments'
  `(siteId, postId)` envelope, blobble's plain timestamped text).
- Join `sender` against on-chain registries (ENS, ECDSARegistry,
  StakeManager).
- Materialize derived views (thread trees, profile timelines).
- Surface anything richer than a paginated `GET /messages`.

Some layer has to do those things. Putting them in the FE means
every app re-implements the same thread tree, the same ENS lookup,
the same stake join. The indexer is the single place that work
lives, with handlers as the per-app extension points.

## Why hand-rolled REST over PostgREST or GraphQL (today)

PostgREST and Postgraphile/Hasura are reasonable answers when the
indexer has ≥2 handlers and a real federation requirement. v1 ships
one handler (Twitter) and four routes; the operational cost of a
PostgREST sidecar isn't justified yet. Revisit when comments + blobble
handlers land in Phase 2.

The route surface is intentionally narrow — every route maps to one
indexed query. If a handler grows past ~6 routes the cost-benefit
flips toward a generated layer.

## Postgres role split

Two roles:

- `indexer_reader` — `SELECT` on `public.messages`, `public.batches`.
- `indexer_writer` — full rights on `indexer.*` and per-handler
  schemas (`twitter.*`, …).

Defense in depth: a bug in `handler.project` can never corrupt
Reader-owned tables. In dev the same DSN works for both
(`INDEXER_DB_URL` falls back into `INDEXER_WRITE_DB_URL`).

## Reorg semantics

Reader's `markReorged` in `packages/bam-store/src/postgres.ts:495`
atomically flips `batches.status='reorged' + invalidated_at` and
cascades `messages.status='reorged'` for every row under that
`batch_ref`. The indexer cursors on `batches.invalidated_at` — a
per-handler "highest seen" timestamp — so a reorg surfacing in the
source DB is visible on the next tick without any L1 RPC.

Per-handler reorg = `handler.onReorg(reorgedTxHash, chainId, txn)`.
The Twitter handler `DELETE`s its rows by `batch_ref`, which keys
off the same column Reader cascades. The framework calls it inside
a write txn so the eviction + cursor bump are atomic.

## Trust model (ERC-8179 / ERC-8180)

Indexers are not trusted. The standards explicitly support multiple
independent indexers per `contentTag`, and the framework here is
deterministic given:

- a fixed source DB state (Reader-written),
- a fixed handler set + version,
- and the same enrichment configuration.

Enricher outputs (ENS, eventually stake) are advisory — consumers
should treat them as such. Two indexers with different RPCs may
divergence on `sender_ens`, never on whether a message was
confirmed.

## Schema versioning

No migration library. Each handler declares a `version` (integer).
On startup the framework compares `handler.version` to the row in
`indexer.cursor`. Mismatch → `DROP SCHEMA <handler.schema> CASCADE`,
delete the cursor, run `handler.migrate()`, re-project from genesis.

Trade-off: a busy deployment loses its projection on a version bump
and rebuilds from genesis. The alternative (parallel versions, dual
writes) is over-engineering for a v1 with one handler. Source-DB
rows are never touched — only the handler's own tables.

## Out of scope (deferred)

- Comments + blobble handlers (Phase 2).
- Stake / ECDSARegistry / allowlist enrichers (Phase 3 — needs
  `StakeManager` deployed).
- PostgREST / GraphQL gateway (Phase 4 — when ≥2 handlers exist).
- Reader HTTP source mode (today the indexer reads `bam-store`
  Postgres directly; the interface allows swapping in an HTTP
  source for third-party operators who don't own the DB).
- Out-of-tree handler plugins. v1 keeps handlers in-tree; fork the
  package if you need a custom handler.
- Auth — read-only, public, fronted by a proxy if exposed.
