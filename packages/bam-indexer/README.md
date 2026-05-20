# bam-indexer

Node service that consumes confirmed BAM messages from `bam-store`,
materializes app-shaped entities per `contentTag` via in-tree
handlers, and serves a multi-consumer REST API. Handle resolution
(ENS, stake-weighted display names) is the consumer's responsibility
— the indexer ships chain-anchored entities, not derived identity.

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
                          ├─ enricher pool     (placeholders only)
                          └─ projection writes ──► handler schemas
                                                     │
                                                     ▼
                                              REST  (per handler routes)
                                                     │
                                              apps / BFFs / dApps
```

## Handlers shipped in this package

The package ships one handler **factory** — `createPostReplyHandler` —
for the flat post + one-level reply primitive (post / reply with utf-8
content, parent linked by ERC-8180 `messageHash`). Each app that wants
this shape calls the factory with its own `(contentTag, schema, name)`
and the framework registers the result side-by-side with any other
handlers.

`src/bin/bam-indexer.ts` instantiates it once for the bam-twitter demo:

| Instance | `contentTag` | Schema | Routes |
|---|---|---|---|
| `twitter` (post-reply) | `keccak256(utf8("bam-twitter.v1"))` | `twitter` | `GET /twitter/posts`, `GET /twitter/posts/:messageId`, `GET /twitter/replies`, `GET /twitter/profile/:sender`, `GET /twitter/versions`. All read routes accept `?version=<uuid>`; default is the current generation. |

A second app sharing this Poster appends another `createPostReplyHandler({...})`
to the `HANDLERS` array — that's the whole change on the indexer side.

The framework's built-in route is `GET /health`.

## Subcommands

```bash
bam-indexer serve                                        # long-running daemon
bam-indexer reset --handler twitter --yes                # drop every generation (rows + cursors)
bam-indexer reset --handler twitter --current --yes      # drop just the current generation; next start bootstraps a fresh version_id
bam-indexer reset --handler twitter --version <uuid> --yes  # drop one specific frozen generation
```

`reset` is destructive — `--yes` is required. `--version` and
`--current` are mutually exclusive.

## Environment

| Var | Default | Notes |
|---|---|---|
| `INDEXER_CHAIN_ID` | — | Required. Used as the `chain_id` filter on every `messages` / `batches` read. |
| `INDEXER_DB_URL` | — | Required. Read-only DSN for `bam-store` (`messages` + `batches`). |
| `INDEXER_TWITTER_TAG` | — | Required. 0x-prefixed 32-byte hex — the `contentTag` the post-reply handler registers for. `keccak256(utf8("bam-twitter.v1"))` on production. |
| `INDEXER_WRITE_DB_URL` | falls back to `INDEXER_DB_URL` | DSN for the indexer's own schemas (`indexer.*`, `twitter.*`). In production, give the indexer a writer role on these schemas only and a reader role on `bam-store`'s tables. |
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

## Schema versioning (generations)

Every handler row carries a `version_id` (UUID). On startup the
framework compares the in-code `handler.version` integer against
the current `indexer.cursor.handler_version`:

1. **No row yet** → INSERT a current cursor at genesis under a
   fresh `version_id`. `handler.migrate()` runs (idempotent DDL).
2. **Match** → reuse the existing `version_id` and keep ticking.
3. **Mismatch** → in one txn, flip the existing row's
   `is_current=false` + `superseded_at=now`, INSERT a new current
   row at genesis under a fresh `version_id`. Old rows in the
   handler's tables keep their `version_id` and stay queryable.
   The next tick re-projects from genesis under the new id.

Old generations are **frozen at supersession**: they stop adding
new rows. Reorgs still cascade through them via
`handler.onReorg`'s `DELETE … WHERE batch_ref = $1`, so chain
truth stays consistent across every retained generation.

Consumers select a generation via `?version=<uuid>` on the
post-reply routes (default: current). `GET /<name>/versions` lists
every generation for the handler. The DDL change (PK becomes
`(version_id, message_id)`, indexes lead with `version_id`) means
upgrading from an older single-version schema requires
`bam-indexer reset --handler <name> --yes` once.

## Trust model (ERC-8179 / ERC-8180)

Indexers are not trusted. Anyone running the same handler set
against the same `bam-reader` Postgres MUST converge on the same
entities for the same `(contentTag, chainId)`. The framework is
deterministic given the source rows; the only non-deterministic
slot is the enricher pool (stake / ECDSA registry / allowlist) and
consumers should treat enricher results as advisory.

## Reorgs

`bam-reader.markReorged` atomically flips both the `batches` row
(`status='reorged' + invalidated_at`) and every `messages` row
under that `batch_ref` (`status='reorged'`). The indexer cursors on
`batches.invalidated_at` — a per-handler "highest seen" — and calls
`handler.onReorg(reorgedTxHash, chainId, txn)` for each newly
reorged batch. The post-reply handler `DELETE`s by `batch_ref`, which
matches Reader's cascade.

## Adding a handler

### Reusing the `post-reply` primitive

If your app fits the flat post + one-level reply shape (utf-8 content,
optional `parentMessageHash`), call the factory directly and add it
to `HANDLERS` in `src/bin/bam-indexer.ts`:

```ts
import { createPostReplyHandler } from 'bam-indexer';

const MY_APP_TAG = '0x…' as Bytes32; // keccak256("my-app.v1")
const myAppHandler = createPostReplyHandler({
  name: 'my-app',
  contentTag: MY_APP_TAG,
  schema: 'my_app',
  // routePrefix defaults to `/${name}`
});
```

The factory wires the schema (`<schema>.posts`), the four routes
(`/${name}/posts`, `/${name}/posts/:messageId`, `/${name}/replies`,
`/${name}/profile/:sender`), and the reorg cascade.

### Authoring a new handler shape

If your app needs a different entity model (nested threads, comments
keyed by post-id, etc.), implement `IndexerHandler<E>` from scratch:

```ts
import { decodeMyContents } from 'bam-sdk/my-app';
import type { IndexerHandler } from 'bam-indexer';

export const myHandler: IndexerHandler<MyPayload> = {
  contentTag: '0x…',
  name: 'my-app',
  version: 1,
  schema: 'my_app',
  async migrate(c) { /* CREATE TABLE IF NOT EXISTS … */ },
  decode(bytes) { try { return decodeMyContents(bytes).app; } catch { return null; } },
  // enrichments: optional — placeholders for stake / ECDSA registry / allowlist.
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
