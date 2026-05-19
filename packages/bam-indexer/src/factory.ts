/**
 * `createIndexer` — assembles the framework + handlers + enrichers
 * + HTTP into a single object the CLI and tests both operate
 * against. The shape mirrors the Reader's `createReader` factory:
 * heavy dependencies (DB pools, viem client) are injectable, an
 * `extras` bag lets tests substitute fakes.
 */

import type { Pool } from 'pg';
import pg from 'pg';

import type { IndexerHandler } from './framework/handler.js';
import { HandlerRegistry } from './framework/registry.js';
import {
  migrate,
  resetHandler,
  resetHandlerCurrent,
  resetHandlerVersion,
} from './framework/migrate.js';
import { tick } from './framework/tick.js';
import { BamStoreSource } from './source/bam-store-source.js';
import { BatchEnricherPool } from './enrichers/batch.js';
import { IndexerHttpServer } from './http/server.js';
import { UnknownHandlerError } from './errors.js';
import type { IndexerConfig, IndexerCounters, IndexerEvent, IndexerLogger } from './types.js';

export interface IndexerFactoryExtras {
  handlers: ReadonlyArray<IndexerHandler<unknown>>;
  source?: BamStoreSource;
  writePool?: Pool;
  logger?: IndexerLogger;
}

export interface Indexer {
  serve(): Promise<void>;
  tickOnce(): Promise<IndexerCounters>;
  health(): Promise<{ port: number; host: string }>;
  resetHandler(name: string): Promise<void>;
  resetHandlerCurrent(name: string): Promise<void>;
  resetHandlerVersion(name: string, versionId: string): Promise<void>;
  close(): Promise<void>;
  /** Test helper: HTTP port assigned by the OS when `httpPort=0`. */
  port(): number;
}

const { Pool: PgPool } = pg;

export async function createIndexer(
  config: IndexerConfig,
  extras: IndexerFactoryExtras
): Promise<Indexer> {
  const logger: IndexerLogger = extras.logger ?? defaultLogger;

  const registry = new HandlerRegistry(extras.handlers);

  const writePool: Pool = extras.writePool ?? new PgPool({ connectionString: config.writeDbUrl });
  writePool.on('error', (err) => {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`[bam-indexer] idle pg client error (write): ${detail}\n`);
  });

  const source = extras.source ?? BamStoreSource.fromUrl(config.sourceDbUrl);

  const enrichers = new BatchEnricherPool();

  await migrate({ writePool, handlers: registry.all(), logger });

  const http_ = await IndexerHttpServer.start({
    chainId: config.chainId,
    registry,
    writePool,
    host: config.httpBind,
    port: config.httpPort,
  });
  logger({ event: 'http_started', detail: { port: http_.port(), host: http_.hostname() }, ts: Date.now() });

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let resolveServe: (() => void) | null = null;

  const runTick = async (): Promise<IndexerCounters> => {
    const start = Date.now();
    logger({ event: 'tick_start', ts: start });
    const result = await tick({
      chainId: config.chainId,
      registry,
      source,
      writePool,
      enrichers,
      logger,
      batchSize: config.batchSize,
    });
    logger({
      event: 'tick_done',
      detail: { byHandler: result.byHandler, elapsedMs: Date.now() - start },
      ts: Date.now(),
    });
    return { byHandler: result.byHandler };
  };

  const indexer: Indexer = {
    async serve() {
      // Single in-flight tick at a time. If a tick runs long, we
      // skip the next interval rather than overlap.
      const loop = (): void => {
        if (stopped) return;
        runTick()
          .catch((err) => {
            const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
            process.stderr.write(`[bam-indexer] tick failed: ${detail}\n`);
          })
          .finally(() => {
            if (stopped) return;
            timer = setTimeout(loop, config.pollMs);
          });
      };
      timer = setTimeout(loop, 0);
      await new Promise<void>((resolve) => {
        if (stopped) {
          resolve();
          return;
        }
        resolveServe = resolve;
      });
    },
    async tickOnce() {
      return await runTick();
    },
    async health() {
      return { port: http_.port(), host: http_.hostname() };
    },
    async resetHandler(name: string) {
      const handler = registry.get(name);
      if (handler === undefined) {
        throw new UnknownHandlerError(name, registry.names());
      }
      await resetHandler(writePool, handler);
    },
    async resetHandlerCurrent(name: string) {
      const handler = registry.get(name);

      await resetHandlerCurrent(writePool, handler);
    },
    async resetHandlerVersion(name: string, versionId: string) {
      const handler = registry.get(name);
      if (handler === undefined) {
        throw new UnknownHandlerError(name, registry.names());
      }
      await resetHandlerVersion(writePool, handler, versionId);
    },
    async close() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      if (resolveServe !== null) {
        resolveServe();
        resolveServe = null;
      }
      await http_.close();
      if (extras.source === undefined) await source.close();
      if (extras.writePool === undefined) await writePool.end();
    },
    port() {
      return http_.port();
    },
  };

  return indexer;
}

function defaultLogger(event: IndexerEvent): void {
  // Stderr-only by default. Operators wire a structured logger via
  // `extras.logger` in production deployments.
  const line = JSON.stringify(event);
  process.stderr.write(`[bam-indexer] ${line}\n`);
}
