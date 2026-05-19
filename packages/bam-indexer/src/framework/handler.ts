/**
 * Indexer handler interface. One `IndexerHandler` per `contentTag`.
 *
 * The framework knows nothing about Twitter, Comments, or any other
 * app: it routes confirmed `MessageRow`s to handlers by `contentTag`,
 * resolves declared enrichments, hands the typed payload + enrichment
 * result to `project`, and wires `routes` into the HTTP server under
 * the handler's `name` prefix. Application-shaped concerns (feed,
 * ranking, FE response shape) belong further up the stack — not here.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PoolClient } from 'pg';
import type { Bytes32 } from 'bam-sdk';
import type { MessageRow } from 'bam-store';

export interface EnrichmentRequest {
  kind: 'stake' | 'ecdsa-registry' | 'allowlist';
  /** Whose address to enrich. `sender` = per-message signer; `submitter` = batch poster. */
  from: 'sender' | 'submitter';
}

export interface EnrichmentResult {
  stake?: bigint | null;
  ecdsaRegistered?: boolean | null;
  allowlisted?: boolean | null;
}

/**
 * Handler-owned HTTP route. Mounted by the framework at
 * `/<handler.name><path>` so two handlers can't collide. Handlers
 * MUST treat `db` as a pool checkout — it's released when the
 * route returns.
 */
export interface BoundHandlerRoute {
  method: 'GET';
  /** Leading slash required, e.g. '/posts' or '/posts/:messageId'. */
  path: string;
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    db: PoolClient
  ) => Promise<void>;
}

export interface IndexerHandler<E> {
  /** keccak256("<app>.v1") — routing key into the message stream. */
  contentTag: Bytes32;
  /** Stable; used as URL prefix, schema name, and cursor key. */
  name: string;
  /**
   * Bump to invalidate this handler's projection. The framework
   * detects the bump on startup, truncates `<schema>.*`, deletes
   * the cursor row, and re-projects from genesis on the next tick.
   */
  version: number;
  /** Postgres schema this handler owns. Created and migrated below. */
  schema: string;

  /**
   * Idempotent DDL. Called on every startup; safe to run twice.
   * The framework runs this AFTER a version-bump truncate, so the
   * handler doesn't need to handle a half-migrated schema.
   */
  migrate(client: PoolClient): Promise<void>;

  /**
   * Decode the message payload. Return `null` to drop a malformed
   * row (the framework increments `skippedDecode` and advances the
   * cursor past it). Throwing here is treated the same as `null`.
   */
  decode(contents: Uint8Array): E | null;

  enrichments?: EnrichmentRequest[];

  /**
   * Project a decoded message into the handler's tables. Must be
   * idempotent w.r.t. `message_id` (or `(sender, nonce)` if
   * `message_id` is null) — the framework may re-call this after
   * a crash mid-tick.
   */
  project(
    msg: MessageRow,
    decoded: E,
    enriched: EnrichmentResult,
    txn: PoolClient
  ): Promise<void>;

  /**
   * Called once per reorged batch tx-hash on this chain. Handler
   * decides how to evict — typically `DELETE FROM <schema>.<table>
   * WHERE batch_ref = $1`. Idempotent; framework re-calls on retry.
   */
  onReorg(
    reorgedTxHash: Bytes32,
    chainId: number,
    txn: PoolClient
  ): Promise<void>;

  routes: BoundHandlerRoute[];
}
