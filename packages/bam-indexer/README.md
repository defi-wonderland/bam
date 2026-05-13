# bam-indexer

Node service that consumes confirmed BAM messages from `bam-store`,
materializes app-shaped entities per `contentTag` via in-tree
handlers, augments with on-chain reads (ENS today; stake + identity
later), and serves a multi-consumer REST API.

Sits **above** `bam-reader` (which is the protocol-level indexer
for ERC-8180 events → decoded messages) and **below** per-FE BFFs
(which shape application responses). The indexer's boundary is
typed entities + queries; ranking / personalization / feed assembly
belong elsewhere.

The indexer is **not a required dependency** of any BAM app. Every
client-facing surface that uses it must declare a `bam-reader`
fallback per `.specify/memory/constitution.md`'s degraded-mode
requirement. The Twitter app does this in
`apps/bam-twitter/src/app/api/confirmed-messages/route.ts`.

## Architecture

```
bam-reader ── upserts ──► bam-store (Postgres)
                              │  (read-only role)
                              ▼
                       bam-indexer
                          ├─ cursor per handler (indexer.cursor)
                          ├─ handler registry  (in-tree)
                          ├─ enricher pool     (ENS)
                          └─ projection writes ──► handler schemas
                                                     │
                                                     ▼
                                              REST  (per handler routes)
                                                     │
                                              apps / BFFs / dApps
```

## Handlers shipped in this package

| Handler | `contentTag` | Schema | Routes |
|---|---|---|---|
| `twitter` | `keccak256(utf8("bam-twitter.v1"))` | `twitter` | `GET /twitter/posts`, `GET /twitter/posts/:messageId`, `GET /twitter/replies`, `GET /twitter/profile/:sender` |

The framework's built-in route is `GET /health`.

## Subcommands

```bash
bam-indexer serve                            # long-running daemon
bam-indexer reset --handler twitter --yes    # truncate twitter.*, drop cursor
```

`reset` is destructive — `--yes` is required.

## Environment

| Var | Default | Notes |
|---|---|---|
| `INDEXER_CHAIN_ID` | — | Required. Used as the `chain_id` filter on every `messages` / `batches` read. |
| `INDEXER_DB_URL` | — | Required. Read-only DSN for `bam-store` (`messages` + `batches`). |
| `INDEXER_WRITE_DB_URL` | falls back to `INDEXER_DB_URL` | DSN for the indexer's own schemas (`indexer.*`, `twitter.*`). In production, give the indexer a writer role on these schemas only and a reader role on `bam-store`'s tables. |
| `INDEXER_RPC_URL` | — | viem JSON-RPC endpoint for enrichers (ENS today). When unset, ENS resolves as `null`. |
| `INDEXER_POLL_MS` | `5000` | Tick cadence. |
| `INDEXER_BATCH_SIZE` | `200` | Rows pulled per handler per tick. |
| `INDEXER_HTTP_BIND` | `127.0.0.1` | Bind address. Mirrors Reader's red-team C-1 posture; operator fronts it. |
| `INDEXER_HTTP_PORT` | `8789` | |
| `INDEXER_ENV_FILE` | — | Explicit dotenv override. Otherwise walks up from cwd looking for `.env.local` / `.env`. |

## Postgres role split (recommended)

```sql
-- Reader's existing user keeps full ownership of messages/batches.
CREATE ROLE indexer_reader LOGIN PASSWORD '…';
GRANT USAGE  ON SCHEMA public TO indexer_reader;
GRANT SELECT ON public.messages, public.batches TO indexer_reader;

CREATE ROLE indexer_writer LOGIN PASSWORD '…';
GRANT ALL ON SCHEMA indexer, twitter TO indexer_writer;
```

Defense in depth: a bug in a handler's `project` can never touch
Reader-owned tables. In dev the same DSN works for both — the env
falls back accordingly.

## Schema versioning

Each handler declares a `version` (integer). On startup the
framework compares it to the `indexer.cursor.handler_version` row.
On mismatch:

1. `DROP SCHEMA <handler.schema> CASCADE` — destructive.
2. Delete the cursor row for that handler.
3. `handler.migrate()` recreates the schema and tables.
4. The next tick re-projects from genesis (the source-DB rows are
   untouched; this is purely an indexer-side rebuild).

Bumping a handler's version is the only mechanism today. There's
no migration library — this is intentional and mirrors the
`bam-store` posture in
`packages/bam-store/src/schema/index.ts`.

## Trust model (ERC-8179 / ERC-8180)

Indexers are not trusted. Anyone running the same handler set
against the same `bam-reader` Postgres MUST converge on the same
entities for the same `(contentTag, chainId)`. The framework is
deterministic given the source rows; enricher results (ENS, stake)
are documented divergence points and consumers should treat them
as advisory.

## Reorgs

`bam-reader.markReorged` atomically flips both the `batches` row
(`status='reorged' + invalidated_at`) and every `messages` row
under that `batch_ref` (`status='reorged'`). The indexer cursors on
`batches.invalidated_at` — a per-handler "highest seen" — and calls
`handler.onReorg(reorgedTxHash, chainId, txn)` for each newly
reorged batch. The Twitter handler `DELETE`s by `batch_ref`, which
matches Reader's cascade.

## Adding a handler

A handler is a TypeScript module exporting an `IndexerHandler<E>`:

```ts
import { decodeMyContents } from 'bam-app-codecs/my-app';
import type { IndexerHandler } from 'bam-indexer';

export const myHandler: IndexerHandler<MyPayload> = {
  contentTag: '0x…',
  name: 'my-app',
  version: 1,
  schema: 'my_app',
  async migrate(c) { /* CREATE TABLE IF NOT EXISTS … */ },
  decode(bytes) { try { return decodeMyContents(bytes).app; } catch { return null; } },
  enrichments: [{ kind: 'ens', from: 'sender' }],
  async project(msg, decoded, enr, txn) { /* INSERT … ON CONFLICT … */ },
  async onReorg(txHash, _chainId, txn) {
    await txn.query('DELETE FROM my_app.entities WHERE batch_ref = $1', [txHash.toLowerCase()]);
  },
  routes: [
    /* GET /my-app/… handlers */
  ],
};
```

Then add it to the array in `src/bin/bam-indexer.ts`. There's no
plugin loader — out-of-tree handlers fork the package today.
Revisit when there's a real third-party asking.

## Testing

```bash
pnpm --filter bam-indexer test:run
```

Unit tests cover the registry contract, the tick loop's forward
and reorg passes (against a recording fake `Pool`), and the Twitter
handler's decode/project/onReorg paths. Integration tests against a
real Postgres are deferred — bring up `pnpm db:up` and exercise
via `bam-indexer serve` for now.
