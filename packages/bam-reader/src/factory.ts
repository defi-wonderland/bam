/**
 * Factory wiring for the BAM Reader.
 *
 * `createReader(config)` returns:
 *   - `serve()` — start the live-tail loop on a polling timer; resolves
 *     when `close()` is called.
 *   - `backfill(from, to)` — run one backfill pass over the range.
 *   - `health()` — return the documented `/health` JSON shape.
 *   - `close()` — stop loops cleanly, close the store.
 *
 * At construction time (per red-team C-3) the factory cross-checks
 * `READER_CHAIN_ID` against the RPC's reported chain id; mismatch
 * throws `ChainIdMismatch` and refuses to serve.
 *
 * Heavy dependencies (viem `publicClient`, the bam-store backend)
 * are *injectable* so tests can drive the factory without touching
 * the network or the filesystem.
 */

import type { BamStore } from 'bam-store';
import {
  createDbStore,
  createMemoryStore,
} from 'bam-store';

import { ChainIdMismatch } from './errors.js';
import { assertChainIdMatches } from './bin/env.js';
import {
  backfill as runBackfill,
  type BackfillCounters,
} from './loop/backfill.js';
import {
  liveTailTick,
  type LiveTailL1Client,
} from './loop/live-tail.js';
import {
  emptyCounters,
} from './loop/process-batch.js';
import { ReaderReorgWatcher } from './reorg-watcher.js';
import type { ReaderConfig, ReaderCounters, ReaderEvent } from './types.js';
import type { ReadContractClient } from './decode/on-chain-decoder.js';
import type { VerifyReadContractClient } from './verify/on-chain-registry.js';

export interface ReaderHealthSnapshot {
  chainId: number;
  cursor: { lastBlockNumber: number; lastTxIndex: number; updatedAt: number } | null;
  blocksBehindHead: number | null;
  counters: ReaderCounters;
}

export interface Reader {
  serve(): Promise<void>;
  backfill(from: number, to: number): Promise<BackfillCounters>;
  health(): Promise<ReaderHealthSnapshot>;
  close(): Promise<void>;
}

export interface ReaderFactoryExtras {
  /** L1 client implementing the live-tail interface. */
  l1: LiveTailL1Client;
  /** Optional eth_call client used for non-zero decoder addresses. */
  decodePublicClient?: ReadContractClient;
  /** Optional eth_call client used for non-zero registry addresses. */
  verifyPublicClient?: VerifyReadContractClient;
  /** Optional pre-constructed store; if absent, the factory builds one from `config.dbUrl`. */
  store?: BamStore;
  /** Optional logger; default writes to stderr. */
  logger?: (event: ReaderEvent) => void;
  /** Time between live-tail polls. Default 12s. */
  livePollMs?: number;
  /** Initial block for first-time deployments. */
  startBlock?: number;
}

const DEFAULT_LIVE_POLL_MS = 12_000;

async function createStoreFromDbUrl(dbUrl: string): Promise<BamStore> {
  if (dbUrl === 'memory:' || dbUrl === 'memory') {
    return createMemoryStore();
  }
  if (dbUrl.startsWith('postgres:') || dbUrl.startsWith('postgresql:')) {
    return createDbStore({ postgresUrl: dbUrl });
  }
  if (dbUrl.startsWith('sqlite:')) {
    throw new Error(
      `READER_DB_URL=${dbUrl}: SQLite is no longer supported. Use ` +
        'memory: for an in-process PGLite store, or a postgres:// URL.'
    );
  }
  throw new Error(
    `unrecognized READER_DB_URL: ${dbUrl} (expect postgres://... or memory:)`
  );
}

export async function createReader(
  config: ReaderConfig,
  extras: ReaderFactoryExtras
): Promise<Reader> {
  // 1. Validate chainId at construction (red-team C-3).
  await assertChainIdMatches(extras.l1, config.chainId);

  const store = extras.store ?? (await createStoreFromDbUrl(config.dbUrl));
  const counters = emptyCounters();
  const startBlock = extras.startBlock ?? 0;
  const pollMs = extras.livePollMs ?? DEFAULT_LIVE_POLL_MS;

  const sources = {
    beaconUrl: config.beaconUrl,
    blobscanUrl: config.blobscanUrl,
  };

  const reorgWatcher = new ReaderReorgWatcher({
    store,
    blockSource: extras.l1,
    chainId: config.chainId,
    reorgWindowBlocks: config.reorgWindowBlocks,
  });

  let stopped = false;
  let serveResolve: (() => void) | null = null;
  let serveLoop: Promise<void> | null = null;

  const reader: Reader = {
    async serve() {
      if (serveLoop) return serveLoop;
      serveLoop = (async () => {
        while (!stopped) {
          try {
            await liveTailTick({
              store,
              l1: extras.l1,
              chainId: config.chainId,
              bamCoreAddress: config.bamCoreAddress,
              contentTags: config.contentTags,
              reorgWindowBlocks: config.reorgWindowBlocks,
              startBlock,
              ethCallGasCap: config.ethCallGasCap,
              ethCallTimeoutMs: config.ethCallTimeoutMs,
              sources,
              decodePublicClient: extras.decodePublicClient,
              verifyPublicClient: extras.verifyPublicClient,
              counters,
              logger: extras.logger,
              reorgWatcher,
            });
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            extras.logger?.({ kind: 'live_tail_tick_failed', error: detail });
            // Surface unhandled errors via stderr so operators see them.
            process.stderr.write(`[bam-reader] live-tail tick failed: ${detail}\n`);
          }
          if (stopped) break;
          await new Promise<void>((resolve) => {
            serveResolve = resolve;
            setTimeout(resolve, pollMs);
          });
        }
      })();
      return serveLoop;
    },

    async backfill(from, to) {
      return runBackfill({
        store,
        l1: extras.l1,
        chainId: config.chainId,
        bamCoreAddress: config.bamCoreAddress,
        contentTags: config.contentTags,
        fromBlock: from,
        toBlock: to,
        ethCallGasCap: config.ethCallGasCap,
        ethCallTimeoutMs: config.ethCallTimeoutMs,
        sources,
        decodePublicClient: extras.decodePublicClient,
        verifyPublicClient: extras.verifyPublicClient,
        counters,
        logger: extras.logger,
      });
    },

    async health() {
      const cursor = await store.withTxn((txn) => txn.getCursor(config.chainId));
      let head: number | null = null;
      try {
        head = Number(await extras.l1.getBlockNumber());
      } catch {
        head = null;
      }
      const blocksBehindHead =
        head !== null && cursor !== null ? Math.max(0, head - cursor.lastBlockNumber) : null;
      return {
        chainId: config.chainId,
        cursor:
          cursor === null
            ? null
            : {
                lastBlockNumber: cursor.lastBlockNumber,
                lastTxIndex: cursor.lastTxIndex,
                updatedAt: cursor.updatedAt,
              },
        blocksBehindHead,
        counters: { ...counters },
      };
    },

    async close() {
      stopped = true;
      if (serveResolve) serveResolve();
      if (serveLoop) {
        await serveLoop;
        serveLoop = null;
      }
      if (!extras.store) {
        // We own this store — close it. Caller-supplied stores are
        // closed by the caller.
        await store.close();
      }
    },
  };

  return reader;
}

export { ChainIdMismatch };
