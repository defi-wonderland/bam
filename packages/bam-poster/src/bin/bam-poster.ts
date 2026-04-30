#!/usr/bin/env node
/**
 * `bam-poster` CLI entrypoint. Reads env config, constructs the
 * Poster, mounts HTTP on HOST:PORT, handles SIGTERM/SIGINT → graceful
 * shutdown.
 *
 * Exit codes:
 *   0 — graceful shutdown
 *   2 — env config error (missing / malformed required env)
 *   3 — startup reconciliation error (chain-ID mismatch, missing code)
 *   1 — any other uncaught error
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { config as dotenvConfig } from 'dotenv';

import { EnvConfigError, parseEnv } from './env.js';
import { HttpServer } from '../http/server.js';
import { createPoster } from '../factory.js';
import { LocalEcdsaSigner } from '../signer/local.js';
import { createDbStore, createMemoryStore } from 'bam-store';
import { StartupReconciliationError } from '../startup/reconcile.js';
import { DEFAULT_MAX_MESSAGE_SIZE_BYTES } from '../ingest/size-bound.js';

/**
 * Resolve + load a dotenv file so users don't have to `export` each
 * POSTER_* var before running. Resolution order:
 *   1. `POSTER_ENV_FILE` — explicit override (e.g.
 *      `POSTER_ENV_FILE=.env.sepolia pnpm dev:poster`).
 *   2. Walk up (bounded at 5 ancestors) looking for `.env.local`,
 *      then `.env`, in each directory. `.env.local` wins within a
 *      directory — consistent with Next.js / Vite conventions and
 *      matches the root `.gitignore`'s `!.env.*.example` un-ignore
 *      so `.env.local.example` can be committed as a template.
 *
 * Existing `process.env` values always win — dotenv only fills in
 * variables that aren't already set, matching standard semantics.
 */
function loadDotenv(): void {
  const explicit = process.env.POSTER_ENV_FILE;
  if (explicit !== undefined && explicit !== '') {
    if (existsSync(explicit)) dotenvConfig({ path: explicit });
    return;
  }
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    for (const name of ['.env.local', '.env']) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) {
        dotenvConfig({ path: candidate });
        return;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

export async function runCli(): Promise<void> {
  loadDotenv();
  let env;
  try {
    env = parseEnv();
  } catch (err) {
    if (err instanceof EnvConfigError) {
      process.stderr.write(`bam-poster: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  const signer = new LocalEcdsaSigner(env.signerPrivateKey);
  // CLI default: in-process PGLite when `POSTGRES_URL` is not set; real
  // Postgres when it is. bam-store itself reads no environment
  // variables; the CLI resolves them.
  let store;
  if (env.postgresUrl) {
    store = await createDbStore({ postgresUrl: env.postgresUrl });
  } else {
    // The pre-consolidation CLI used a persistent SQLite file as its
    // default. PGLite-in-memory restores the "open and go" experience
    // for local dev, but a misconfigured production deploy would boot
    // fine and silently lose all pending/submitted state on restart.
    // Surface the swap loudly so the operator notices before the
    // first restart bites them.
    process.stderr.write(
      'bam-poster: WARNING — POSTGRES_URL is unset; using an in-process ' +
        'PGLite store. State is NOT persistent and will be lost on ' +
        'restart. Set POSTGRES_URL to a real Postgres for any deploy ' +
        'that needs durability.\n'
    );
    store = await createMemoryStore();
  }

  // Real on-chain submission via viem — `buildAndSubmitMulti`
  // consults `config.rpcUrl`, builds a packed type-3 tx calling
  // `registerBlobBatches`, waits for inclusion, and returns the
  // receipt. Not wired by `createPoster` itself because it pulls in
  // the KZG trusted setup at runtime.
  const { buildAndSubmitWithViem } = await import('../submission/build-and-submit.js');
  const viemPieces = await buildAndSubmitWithViem({
    rpcUrl: env.rpcUrl,
    chainId: env.chainId,
    bamCoreAddress: env.bamCoreAddress,
    signer,
    decoderAddress: env.decoderAddress,
    signatureRegistryAddress: env.signatureRegistryAddress,
  });

  let poster;
  try {
    poster = await createPoster(
      {
        allowlistedTags: env.allowlistedTags,
        chainId: env.chainId,
        bamCoreAddress: env.bamCoreAddress,
        signer,
        store,
        reorgWindowBlocks: env.reorgWindowBlocks,
        packingLossStreakWarnThreshold: env.packingLossStreakWarnThreshold,
      },
      {
        buildAndSubmitMulti: viemPieces.buildAndSubmitMulti,
        rpc: viemPieces.rpc,
      }
    );
  } catch (err) {
    if (err instanceof StartupReconciliationError) {
      process.stderr.write(`bam-poster: ${err.message}\n`);
      process.exit(3);
    }
    throw err;
  }

  await poster.start();
  const server = new HttpServer({
    poster,
    maxMessageSizeBytes: DEFAULT_MAX_MESSAGE_SIZE_BYTES,
    authToken: env.authToken,
  });
  await server.listen(env.port, env.host);
  process.stdout.write(`bam-poster listening on ${env.host}:${env.port}\n`);

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`bam-poster received ${signal}, shutting down\n`);
    try {
      await server.close();
      // poster.stop() closes the configured store on the way out, so
      // we don't also close `store` here — double-closing some
      // backends throws and flips a graceful shutdown into an error
      // exit (qodo review).
      await poster.stop();
      process.exit(0);
    } catch {
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// Allow both direct invocation (via the "bin" shim) and programmatic
// reuse in tests. `import.meta.url === fileURL(argv[1])` is the
// node-standard way to detect "main module."
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const isMain = (() => {
  try {
    // pnpm's workspace bin shim invokes the script via a symlink under
    // `<package>/node_modules/<package>/dist/...`. `import.meta.url`
    // resolves to the canonical (un-symlinked) path; `process.argv[1]`
    // is the symlinked path. Compare real paths so the entrypoint
    // check fires under both direct and via-bin invocations.
    return (
      fileURLToPath(import.meta.url) ===
      realpathSync(process.argv[1] ?? '')
    );
  } catch {
    return false;
  }
})();

if (isMain) {
  runCli().catch((err) => {
    process.stderr.write(`bam-poster: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
