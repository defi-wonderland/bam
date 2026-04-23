import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  bytesToHex,
  computeMessageHash,
  generateECDSAPrivateKey,
  signECDSA,
  type Address,
  type Bytes32,
} from 'bam-sdk';
import { privateKeyToAccount } from 'viem/accounts';

import { IngestPipeline } from '../../src/ingest/pipeline.js';
import { RateLimiter } from '../../src/ingest/rate-limit.js';
import { SqlitePosterStore } from '../../src/pool/sqlite.js';
import { defaultEcdsaValidator } from '../../src/validator/default-ecdsa.js';

const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;

/**
 * FU-8: the `C-3` atomicity-race test in `test/ingest/pipeline.test.ts`
 * uses `MemoryPosterStore`, whose `AsyncLock` serializes callers
 * through one promise chain. This test re-runs the same parallel-race
 * assertions against a real `SqlitePosterStore` — i.e. with actual
 * `BEGIN IMMEDIATE` transaction scopes backed by a real file — so
 * regressions in the sqlite adapter's transaction boundaries are
 * caught.
 *
 * **Known limitation:** `better-sqlite3` is synchronous. Two
 * `SqlitePosterStore` instances in the *same* node process (same
 * thread, same event loop) deadlock because connection B's
 * `BEGIN IMMEDIATE` is a sync call that blocks the thread while
 * connection A's async `withTxn` callback is mid-await. Real
 * cross-process concurrency against a shared sqlite file requires
 * separate node processes / worker threads, or a shared-nothing
 * architecture with Postgres. Both are out of scope for this test.
 */
describe('Real SQLite concurrency (FU-8)', () => {
  it('50 parallel submits with distinct content but shared (author, nonce) — exactly one accepted', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bam-poster-fu8-'));
    const dbPath = path.join(dir, 'poster.db');
    const store = new SqlitePosterStore(dbPath);

    const pk = generateECDSAPrivateKey() as `0x${string}`;
    const author = privateKeyToAccount(pk).address as Address;
    const timestamp = 1_700_000_000;
    const nonce = 1;
    const N = 50;

    async function envelope(variant: number): Promise<Uint8Array> {
      const content = `variant-${variant}`;
      const hash = computeMessageHash({ author, timestamp, nonce, content });
      const sig = await signECDSA(pk, bytesToHex(hash) as Bytes32);
      return new TextEncoder().encode(
        JSON.stringify({
          contentTag: TAG,
          message: { author, timestamp, nonce, content, signature: bytesToHex(sig) },
        })
      );
    }

    const envelopes = await Promise.all(
      Array.from({ length: N }, (_, i) => envelope(i))
    );
    const pipeline = new IngestPipeline({
      store,
      validator: defaultEcdsaValidator(),
      rateLimiter: new RateLimiter({ windowMs: 60_000, maxPerWindow: 10_000 }),
      allowlistedTags: [TAG],
      maxMessageSizeBytes: 120_000,
      now: () => new Date(0),
    });

    try {
      const results = await Promise.all(envelopes.map((raw) => pipeline.ingest(raw)));
      const accepted = results.filter((r) => r.accepted);
      const rejected = results.filter((r) => !r.accepted);

      expect(accepted).toHaveLength(1);
      expect(rejected).toHaveLength(N - 1);
      for (const r of rejected) {
        if (!r.accepted) expect(r.reason).toBe('stale_nonce');
      }

      const pool = await store.withTxn(async (txn) => txn.listPendingByTag(TAG));
      expect(pool).toHaveLength(1);

      const tracker = await store.withTxn(async (txn) => txn.getNonce(author));
      expect(tracker!.lastNonce).toBe(1n);
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('50 parallel byte-equal retries — all acknowledged, one pool row', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bam-poster-fu8b-'));
    const dbPath = path.join(dir, 'poster.db');
    const store = new SqlitePosterStore(dbPath);

    const pk = generateECDSAPrivateKey() as `0x${string}`;
    const author = privateKeyToAccount(pk).address as Address;
    const timestamp = 1_700_000_000;
    const nonce = 1;
    const content = 'the one and only';
    const hash = computeMessageHash({ author, timestamp, nonce, content });
    const sig = await signECDSA(pk, bytesToHex(hash) as Bytes32);
    const raw = new TextEncoder().encode(
      JSON.stringify({
        contentTag: TAG,
        message: { author, timestamp, nonce, content, signature: bytesToHex(sig) },
      })
    );

    const pipeline = new IngestPipeline({
      store,
      validator: defaultEcdsaValidator(),
      rateLimiter: new RateLimiter({ windowMs: 60_000, maxPerWindow: 10_000 }),
      allowlistedTags: [TAG],
      maxMessageSizeBytes: 120_000,
      now: () => new Date(0),
    });

    try {
      const N = 50;
      const results = await Promise.all(
        Array.from({ length: N }, () => pipeline.ingest(raw))
      );
      expect(results.every((r) => r.accepted)).toBe(true);
      const ids = new Set(
        results.filter((r) => r.accepted).map((r) => (r as { messageId: string }).messageId)
      );
      expect(ids.size).toBe(1);
      const pool = await store.withTxn(async (txn) => txn.listPendingByTag(TAG));
      expect(pool).toHaveLength(1);
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('survives restart: reopen store, nonce tracker + pool intact', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bam-poster-fu8c-'));
    const dbPath = path.join(dir, 'poster.db');

    try {
      const first = new SqlitePosterStore(dbPath);
      const pk = generateECDSAPrivateKey() as `0x${string}`;
      const author = privateKeyToAccount(pk).address as Address;
      const timestamp = 1_700_000_000;
      const hash = computeMessageHash({ author, timestamp, nonce: 1, content: 'restart me' });
      const sig = await signECDSA(pk, bytesToHex(hash) as Bytes32);
      const raw = new TextEncoder().encode(
        JSON.stringify({
          contentTag: TAG,
          message: { author, timestamp, nonce: 1, content: 'restart me', signature: bytesToHex(sig) },
        })
      );
      const pipe1 = new IngestPipeline({
        store: first,
        validator: defaultEcdsaValidator(),
        rateLimiter: new RateLimiter({ windowMs: 60_000, maxPerWindow: 10 }),
        allowlistedTags: [TAG],
        maxMessageSizeBytes: 120_000,
        now: () => new Date(0),
      });
      const r1 = await pipe1.ingest(raw);
      expect(r1.accepted).toBe(true);
      await first.close();

      // Reopen — the pending row + nonce tracker survive, and a
      // replay of the exact same envelope is still the byte-equal
      // no-op (returns the existing messageId).
      const second = new SqlitePosterStore(dbPath);
      const pipe2 = new IngestPipeline({
        store: second,
        validator: defaultEcdsaValidator(),
        rateLimiter: new RateLimiter({ windowMs: 60_000, maxPerWindow: 10 }),
        allowlistedTags: [TAG],
        maxMessageSizeBytes: 120_000,
        now: () => new Date(0),
      });
      const r2 = await pipe2.ingest(raw);
      expect(r2.accepted).toBe(true);
      if (r1.accepted && r2.accepted) expect(r2.messageId).toBe(r1.messageId);

      const pool = await second.withTxn(async (txn) => txn.listPendingByTag(TAG));
      expect(pool).toHaveLength(1);
      await second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
