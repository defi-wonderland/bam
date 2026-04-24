import { describe, expect, it } from 'vitest';
import {
  encodeContents,
  signECDSAWithKey,
  type Address,
  type BAMMessage,
  type Bytes32,
} from 'bam-sdk';

import { IngestPipeline } from '../../src/ingest/pipeline.js';
import { RateLimiter } from '../../src/ingest/rate-limit.js';
import { MemoryPosterStore } from '../../src/pool/memory-store.js';
import type { MessageValidator } from '../../src/types.js';

const CHAIN_ID = 31337;
const PRIV = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const SENDER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;
const PRIV_2 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const SENDER_2 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address;
const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;

function bytesToHexStr(b: Uint8Array): `0x${string}` {
  return ('0x' +
    Array.from(b)
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('')) as `0x${string}`;
}

function signedEnvelope(opts: {
  privateKey?: `0x${string}`;
  sender?: Address;
  nonce?: bigint;
  tag?: Bytes32;
  appBytes?: Uint8Array;
}): Uint8Array {
  const privateKey = opts.privateKey ?? PRIV;
  const sender = opts.sender ?? SENDER;
  const nonce = opts.nonce ?? 1n;
  const tag = opts.tag ?? TAG;
  const appBytes = opts.appBytes ?? new TextEncoder().encode('hi');
  const contents = encodeContents(tag, appBytes);
  const msg: BAMMessage = { sender, nonce, contents };
  const signature = signECDSAWithKey(privateKey, msg, CHAIN_ID);
  const env = {
    contentTag: tag,
    message: {
      sender,
      nonce: nonce.toString(),
      contents: bytesToHexStr(contents),
      signature,
    },
  };
  return new TextEncoder().encode(JSON.stringify(env));
}

interface Harness {
  pipeline: IngestPipeline;
  store: MemoryPosterStore;
  validator: MessageValidator;
  verifyCalls: { count: number };
}

function mkHarness(opts?: {
  validator?: MessageValidator;
  verifyCallCounter?: { count: number };
  rate?: { windowMs: number; maxPerWindow: number };
  allowlist?: Bytes32[];
  maxMessageSizeBytes?: number;
  maxContentsSizeBytes?: number;
}): Harness {
  const store = new MemoryPosterStore();
  const rate = opts?.rate ?? { windowMs: 60_000, maxPerWindow: 1_000 };
  const limiter = new RateLimiter(rate);
  const counter = opts?.verifyCallCounter ?? { count: 0 };
  const validator =
    opts?.validator ?? {
      validate() {
        counter.count++;
        return { ok: true };
      },
    };
  const pipeline = new IngestPipeline({
    store,
    validator,
    rateLimiter: limiter,
    allowlistedTags: opts?.allowlist ?? [TAG],
    maxMessageSizeBytes: opts?.maxMessageSizeBytes ?? 120_000,
    maxContentsSizeBytes: opts?.maxContentsSizeBytes ?? 100_000,
    now: () => new Date(0),
  });
  return { pipeline, store, validator, verifyCalls: counter };
}

describe('IngestPipeline — happy path', () => {
  it('accepts a well-formed signed message and returns messageHash', async () => {
    const h = mkHarness();
    const raw = signedEnvelope({});
    const res = await h.pipeline.ingest(raw);
    expect(res.accepted).toBe(true);
    if (res.accepted) expect(res.messageHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h.verifyCalls.count).toBe(1);
  });

  it('inserted pending row carries sender, nonce, contents, messageHash', async () => {
    const h = mkHarness();
    const raw = signedEnvelope({});
    await h.pipeline.ingest(raw);
    const rows = await h.store.withTxn(async (txn) => txn.listPendingByTag(TAG));
    expect(rows.length).toBe(1);
    expect(rows[0].sender.toLowerCase()).toBe(SENDER.toLowerCase());
    expect(rows[0].nonce).toBe(1n);
    expect(rows[0].contents.length).toBeGreaterThanOrEqual(32);
  });
});

describe('IngestPipeline — structural rejections', () => {
  it('non-JSON envelope → malformed', async () => {
    const h = mkHarness();
    const raw = new TextEncoder().encode('not-json');
    const res = await h.pipeline.ingest(raw);
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason).toBe('malformed');
    expect(h.verifyCalls.count).toBe(0);
  });

  it('contents < 32 bytes → malformed (before validator)', async () => {
    const h = mkHarness();
    const env = {
      contentTag: TAG,
      message: {
        sender: SENDER,
        nonce: '1',
        contents: '0x' + '00'.repeat(16), // only 16 bytes
        signature: '0x' + '00'.repeat(65),
      },
    };
    const raw = new TextEncoder().encode(JSON.stringify(env));
    const res = await h.pipeline.ingest(raw);
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason).toBe('malformed');
  });

  it('oversized envelope (> maxMessageSizeBytes) → message_too_large', async () => {
    const h = mkHarness({ maxMessageSizeBytes: 200 });
    const raw = signedEnvelope({ appBytes: new Uint8Array(1024) });
    const res = await h.pipeline.ingest(raw);
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason).toBe('message_too_large');
    expect(h.verifyCalls.count).toBe(0);
  });
});

describe('IngestPipeline — ordering (CPU-grief) + atomicity', () => {
  it('unsigned garbage never reaches the validator if rate-limit fires first', async () => {
    const h = mkHarness({ rate: { windowMs: 60_000, maxPerWindow: 2 } });
    // Every call comes from the same "sender" (sentinel bucket since
    // signatures won't recover), so the rate-limiter saturates fast.
    const garbage = () => {
      const env = {
        contentTag: TAG,
        message: {
          sender: ('0x' + '00'.repeat(20)) as Address,
          nonce: '1',
          contents: '0x' + 'aa'.repeat(32) + '00',
          signature: '0x' + '11'.repeat(65),
        },
      };
      return new TextEncoder().encode(JSON.stringify(env));
    };
    const results = [];
    for (let i = 0; i < 20; i++) {
      results.push(await h.pipeline.ingest(garbage()));
    }
    const rateLimited = results.filter(
      (r) => !r.accepted && (r as { reason: string }).reason === 'rate_limited'
    ).length;
    expect(rateLimited).toBeGreaterThan(0);
    // The validator counter must not be incremented on rate-limited requests.
    // (It may be called once or twice before the rate-limit kicks in.)
    expect(h.verifyCalls.count).toBeLessThanOrEqual(2);
  });

  it('cross-tag attribution attempts reject before the validator runs', async () => {
    const h = mkHarness({ allowlist: [TAG, ('0x' + 'bb'.repeat(32)) as Bytes32] });
    // Signer signs for TAG but hint says another tag (same allowlist).
    const otherTag = ('0x' + 'bb'.repeat(32)) as Bytes32;
    const contents = encodeContents(TAG, new Uint8Array([1, 2, 3]));
    const msg: BAMMessage = { sender: SENDER, nonce: 1n, contents };
    const signature = signECDSAWithKey(PRIV, msg, CHAIN_ID);
    const env = {
      contentTag: otherTag, // mismatch
      message: {
        sender: SENDER,
        nonce: '1',
        contents: bytesToHexStr(contents),
        signature,
      },
    };
    const raw = new TextEncoder().encode(JSON.stringify(env));
    const res = await h.pipeline.ingest(raw);
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason).toBe('content_tag_mismatch');
    expect(h.verifyCalls.count).toBe(0);
  });

  it('concurrent ingest of the same (sender, nonce) admits exactly one', async () => {
    const h = mkHarness();
    const raw = signedEnvelope({});
    // Same bytes, 20 parallel submits. Monotonicity allows no_op on
    // byte-equal retry, so every concurrent call sees the same
    // messageHash and is "accepted". The pool must still contain
    // exactly one row.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => h.pipeline.ingest(raw))
    );
    for (const r of results) expect(r.accepted).toBe(true);
    const rows = await h.store.withTxn(async (txn) => txn.listPendingByTag(TAG));
    expect(rows.length).toBe(1);
  });

  it('concurrent ingest of distinct (sender, nonce) admits both', async () => {
    const h = mkHarness();
    const raw1 = signedEnvelope({ privateKey: PRIV, sender: SENDER, nonce: 1n });
    const raw2 = signedEnvelope({ privateKey: PRIV_2, sender: SENDER_2, nonce: 1n });
    const [r1, r2] = await Promise.all([
      h.pipeline.ingest(raw1),
      h.pipeline.ingest(raw2),
    ]);
    expect(r1.accepted).toBe(true);
    expect(r2.accepted).toBe(true);
    const rows = await h.store.withTxn(async (txn) => txn.listPendingByTag(TAG));
    expect(rows.length).toBe(2);
  });
});

describe('IngestPipeline — nonce monotonicity end-to-end', () => {
  it('stale nonce (lower than last-accepted) rejects', async () => {
    const h = mkHarness();
    await h.pipeline.ingest(signedEnvelope({ nonce: 5n }));
    const res = await h.pipeline.ingest(signedEnvelope({ nonce: 4n }));
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason).toBe('stale_nonce');
  });

  it('byte-equal retry of last-accepted is a no-op', async () => {
    const h = mkHarness();
    const raw = signedEnvelope({ nonce: 3n });
    const first = await h.pipeline.ingest(raw);
    const second = await h.pipeline.ingest(raw);
    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    const rows = await h.store.withTxn(async (txn) => txn.listPendingByTag(TAG));
    expect(rows.length).toBe(1);
  });
});
