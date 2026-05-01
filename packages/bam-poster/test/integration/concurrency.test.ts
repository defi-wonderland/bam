import { afterEach, describe, expect, it } from 'vitest';
import {
  encodeContents,
  signECDSAWithKey,
  type Address,
  type BAMMessage,
  type Bytes32,
} from 'bam-sdk';

import { IngestPipeline } from '../../src/ingest/pipeline.js';
import { RateLimiter } from '../../src/ingest/rate-limit.js';
import { createMemoryStore } from 'bam-store';
import type { MessageValidator, BamStore } from '../../src/types.js';

/**
 * Integration test — concurrent ingest of the same `(sender, nonce)`
 * against the in-process PGLite store must admit exactly one pool
 * row. PGLite's `SERIALIZABLE` semantics cover the same invariant the
 * SQLite version of this test exercised (file renamed accordingly).
 */

const CHAIN_ID = 31337;
const PRIV = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const SENDER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;
const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;

const stores: BamStore[] = [];

async function newStore(): Promise<BamStore> {
  const s = await createMemoryStore();
  stores.push(s);
  return s;
}

afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

function bytesToHex(b: Uint8Array): `0x${string}` {
  return ('0x' +
    Array.from(b)
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('')) as `0x${string}`;
}

function signedEnvelope(nonce: bigint): Uint8Array {
  const contents = encodeContents(TAG, new TextEncoder().encode('hi'));
  const msg: BAMMessage = { sender: SENDER, nonce, contents };
  const signature = signECDSAWithKey(PRIV, msg, CHAIN_ID);
  const env = {
    contentTag: TAG,
    message: {
      sender: SENDER,
      nonce: nonce.toString(),
      contents: bytesToHex(contents),
      signature,
    },
  };
  return new TextEncoder().encode(JSON.stringify(env));
}

function mkPipeline(store: BamStore): IngestPipeline {
  const okValidator: MessageValidator = {
    validate() {
      return { ok: true };
    },
  };
  return new IngestPipeline({
    store,
    validator: okValidator,
    rateLimiter: new RateLimiter({ windowMs: 60_000, maxPerWindow: 10_000 }),
    allowlistedTags: [TAG],
    maxMessageSizeBytes: 120_000,
    maxContentsSizeBytes: 100_000,
    chainId: 1,
    now: () => new Date(0),
  });
}

describe('concurrency (PGLite) — ingest atomicity', () => {
  it('50 parallel identical submits → exactly one pool row; rest are accepted no-ops', async () => {
    const store = await newStore();
    const pipeline = mkPipeline(store);
    const raw = signedEnvelope(1n);
    const results = await Promise.all(
      Array.from({ length: 50 }, () => pipeline.ingest(raw))
    );
    const accepted = results.filter((r) => r.accepted).length;
    expect(accepted).toBe(50); // byte-equal retry tolerance
    const rows = await store.withTxn((txn) =>
      Promise.resolve(txn.listPendingByTag(TAG))
    );
    expect(rows.length).toBe(1);
  });

  it('concurrent distinct (sender, nonce) pairs all admit', async () => {
    const store = await newStore();
    const pipeline = mkPipeline(store);
    const raws = [1n, 2n, 3n, 4n, 5n].map(signedEnvelope);
    const results = await Promise.all(raws.map((r) => pipeline.ingest(r)));
    for (const r of results) expect(r.accepted).toBe(true);
    const rows = await store.withTxn((txn) =>
      Promise.resolve(txn.listPendingByTag(TAG))
    );
    expect(rows.map((r) => Number(r.nonce)).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('concurrent mix of valid + stale nonces → stale ones reject', async () => {
    const store = await newStore();
    const pipeline = mkPipeline(store);
    // Seed nonce=3 as last-accepted.
    await pipeline.ingest(signedEnvelope(3n));
    const results = await Promise.all([
      pipeline.ingest(signedEnvelope(1n)),
      pipeline.ingest(signedEnvelope(2n)),
      pipeline.ingest(signedEnvelope(4n)),
    ]);
    expect(results[0].accepted).toBe(false);
    expect(results[1].accepted).toBe(false);
    expect(results[2].accepted).toBe(true);
  });
});
