import type { Address } from 'bam-sdk';

import { SCHEMA_VERSION } from '../pool/schema.js';
import { SqlitePosterStore } from '../pool/sqlite.js';
import { PostgresPosterStore } from '../pool/postgres.js';
import type { PosterStore } from '../types.js';

/**
 * Minimal Ethereum JSON-RPC surface the startup reconciliation needs.
 * The real Poster factory wraps a viem `PublicClient`; tests pass a stub.
 */
export interface ReconcileRpcClient {
  getChainId(): Promise<number>;
  getCode(address: Address): Promise<`0x${string}`>;
}

export interface ReconcileConfig {
  chainId: number;
  bamCoreAddress: Address;
}

export class StartupReconciliationError extends Error {}

/**
 * Startup self-check:
 *   - `eth_chainId` matches `config.chainId`.
 *   - `eth_getCode(bamCoreAddress)` is non-empty.
 *   - If the store is DB-backed, its `poster_schema.version` row
 *     matches the current `SCHEMA_VERSION` constant.
 *
 * Throws before the submission loop starts. Mis-matched chain-ID,
 * absent contract code, or a stale pool DB would otherwise let every
 * submission land on the wrong target or reinterpret rows under the
 * wrong schema — fail loudly, not silently.
 */
export async function reconcileStartup(
  rpc: ReconcileRpcClient,
  config: ReconcileConfig
): Promise<void> {
  const chainId = await rpc.getChainId();
  if (chainId !== config.chainId) {
    throw new StartupReconciliationError(
      `chain-id mismatch: RPC=${chainId} expected=${config.chainId}`
    );
  }
  const code = await rpc.getCode(config.bamCoreAddress);
  if (code === '0x' || code === '0x0' || code === ('0x' as `0x${string}`)) {
    throw new StartupReconciliationError(
      `no contract code at bamCoreAddress ${config.bamCoreAddress} on chain ${chainId}`
    );
  }
}

/**
 * Separate schema check so the call site can run it against the
 * store instance (not the RPC). Factory calls both.
 *
 * A mis-matched schema must be resolved by the operator dropping the
 * pool tables; no auto-migration. The error message points operators
 * at the remedy.
 */
export async function reconcileSchemaVersion(store: PosterStore): Promise<void> {
  // Duck-type the adapters that expose a schema-version read. The
  // in-memory store has no persisted schema (always current), so we
  // skip it silently.
  let found: number | null = null;
  if (store instanceof SqlitePosterStore) {
    found = store.readSchemaVersion();
  } else if (store instanceof PostgresPosterStore) {
    found = await store.readSchemaVersion();
  } else {
    return;
  }
  if (found !== SCHEMA_VERSION) {
    throw new StartupReconciliationError(
      `schema-version mismatch: DB=${found} expected=${SCHEMA_VERSION}. ` +
        `Drop the pool tables (poster_pending, poster_nonces, ` +
        `poster_submitted_batches, poster_tag_seq, poster_schema) ` +
        `and restart so the adapter can recreate them at the current version.`
    );
  }
}
