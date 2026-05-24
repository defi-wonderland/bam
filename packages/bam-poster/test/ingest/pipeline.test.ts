import { describe, expect, it } from 'vitest';
import {
  computeMessageHash,
  signECDSAWithKey,
  type Address,
  type BAMMessage,
  type Bytes32,
} from 'bam-sdk';

import { IngestPipeline } from '../../src/ingest/pipeline.js';
import { RateLimiter } from '../../src/ingest/rate-limit.js';
import { createMemoryStore } from 'bam-store';
import type { BamStore } from 'bam-store';
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
  /** Tag the signer commits to, when different from the envelope tag (forgery scenarios). */
  signTag?: Bytes32;
  contents?: Uint8Array;
}): Uint8Array {
  const privateKey = opts.privateKey ?? PRIV;
  const sender = opts.sender ?? SENDER;
  const nonce = opts.nonce ?? 1n;
  const tag = opts.tag ?? TAG;
  const signTag = opts.signTag ?? tag;
  const contents = opts.contents ?? new TextEncoder().encode('hi');
  const msg: BAMMessage = { sender, nonce, contents };
  const signature = signECDSAWithKey(privateKey, msg, signTag, CHAIN_ID);
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
  store: BamStore;
  validator: MessageValidator;
  verifyCalls: { count: number };
}

async function mkHarness(opts?: {
  validator?: MessageValidator;
  verifyCallCounter?: { count: number };
  rate?: { windowMs: number; maxPerWindow: number };
  allowlist?: Bytes32[];
  maxMessageSizeBytes?: number;
  maxContentsSizeBytes?: number;
}): Promise<Harness> {
  const store = await createMemoryStore();
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
    chainId: 1,
    now: () => new Date(0),
  });
  return { pipeline, store, validator, verifyCalls: counter };
}

describe('IngestPipeline — happy path', () => {
  it('accepts a well-formed signed message and returns messageHash', async () => {
    const h = await mkHarness();
    const raw = signedEnvelope({});
    const res = await h.pipeline.ingest(raw);
    expect(res.accepted).toBe(true);
    if (res.accepted) expect(res.messageHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h.verifyCalls.count).toBe(1);
  });

  it('inserted pending row carries sender, nonce, contents, messageHash', async () => {
    const h = await mkHarness();
    const raw = signedEnvelope({});
    await h.pipeline.ingest(raw);
    const rows = await h.store.withTxn(async (txn) => txn.listPendingByTag(TAG));
    expect(rows.length).toBe(1);
    expect(rows[0].sender.toLowerCase()).toBe(SENDER.toLowerCase());
    expect(rows[0].nonce).toBe(1n);
    // After the tag-binding rework, `contents` carries the app body
    // directly — no 32-byte tag prefix.
    expect(rows[0].contents.length).toBeGreaterThan(0);
  });

  it('persisted MessageRow.messageHash equals computeMessageHash(sender, contentTag, nonce, contents)', async () => {
    // Defense-in-depth: the aggregator reads `messageHash` from the
    // persisted row, so a regression in the ingest-side hash formula
    // would silently propagate to confirmed batches. Pin the
    // persisted value against the SDK helper here, with a non-trivial
    // nonce and non-empty body so a misalignment can't accidentally
    // produce the same digest as the canonical zero input.
    const h = await mkHarness();
    const contents = new TextEncoder().encode('persisted-hash-check');
    const raw = signedEnvelope({ nonce: 12n, contents });
    const res = await h.pipeline.ingest(raw);
    expect(res.accepted).toBe(true);
    const rows = await h.store.withTxn(async (txn) => txn.listPendingByTag(TAG));
    expect(rows.length).toBe(1);
    const expected = computeMessageHash(SENDER, TAG, 12n, contents);
    expect(rows[0].messageHash).toBe(expected);
    if (res.accepted) expect(res.messageHash).toBe(expected);
  });
});

describe('IngestPipeline — structural rejections', () => {
  it('non-JSON envelope → malformed', async () => {
    const h = await mkHarness();
    const raw = new TextEncoder().encode('not-json');
    const res = await h.pipeline.ingest(raw);
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason).toBe('malformed');
    expect(h.verifyCalls.count).toBe(0);
  });

  it('oversized envelope (> maxMessageSizeBytes) → message_too_large', async () => {
    const h = await mkHarness({ maxMessageSizeBytes: 200 });
    const raw = signedEnvelope({ contents: new Uint8Array(1024) });
    const res = await h.pipeline.ingest(raw);
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason).toBe('message_too_large');
    expect(h.verifyCalls.count).toBe(0);
  });
});

describe('IngestPipeline — ordering (CPU-grief) + atomicity', () => {
  it('unsigned garbage never reaches the validator if rate-limit fires first', async () => {
    const h = await mkHarness({ rate: { windowMs: 60_000, maxPerWindow: 2 } });
    // Every call comes from the same "sender" (sentinel bucket since
    // signatures won't recover), so the rate-limiter saturates fast.
    const garbage = () => {
      const env = {
        contentTag: TAG,
        message: {
          sender: ('0x' + '00'.repeat(20)) as Address,
          nonce: '1',
          contents: '0x00',
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

  it('envelope contentTag not on allowlist rejects before the validator runs', async () => {
    const h = await mkHarness({ allowlist: [TAG] });
    const offTag = ('0x' + 'cc'.repeat(32)) as Bytes32;
    const raw = signedEnvelope({ tag: offTag, signTag: offTag });
    const res = await h.pipeline.ingest(raw);
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason).toBe('unknown_tag');
    expect(h.verifyCalls.count).toBe(0);
  });

  it('concurrent ingest of the same (sender, nonce) admits exactly one', async () => {
    const h = await mkHarness();
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
    const h = await mkHarness();
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
    const h = await mkHarness();
    await h.pipeline.ingest(signedEnvelope({ nonce: 5n }));
    const res = await h.pipeline.ingest(signedEnvelope({ nonce: 4n }));
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason).toBe('stale_nonce');
  });

  it('byte-equal retry of last-accepted is a no-op', async () => {
    const h = await mkHarness();
    const raw = signedEnvelope({ nonce: 3n });
    const first = await h.pipeline.ingest(raw);
    const second = await h.pipeline.ingest(raw);
    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    const rows = await h.store.withTxn(async (txn) => txn.listPendingByTag(TAG));
    expect(rows.length).toBe(1);
  });
});

describe('IngestPipeline — duplicate (sender, nonce) defense-in-depth', () => {
  // Lazy fill (monotonicity) covers the common Reader-populated-DB
  // scenario; this test pins the seatbelt: if a non-reorged row at
  // (sender, nonce) is somehow already in `messages` AND the
  // monotonicity tracker has been seeded inconsistently with it, the
  // pipeline must surface a clean `duplicate` rejection instead of a
  // 500 `internal_error`.
  it('returns {accepted:false, reason:"duplicate"} on a colliding insert', async () => {
    const h = await mkHarness();
    // Seed a confirmed row at (SENDER, 5) directly via the store.
    await h.store.withTxn(async (txn) => {
      await txn.upsertBatch({
        chainId: 1,
        txHash: ('0x' + '01'.repeat(32)) as Bytes32,
        contentTag: TAG,
        blobVersionedHash: ('0x' + '03'.repeat(32)) as Bytes32,
        batchContentHash: ('0x' + '04'.repeat(32)) as Bytes32,
        blockNumber: 10,
        txIndex: 0,
        status: 'confirmed',
        replacedByTxHash: null,
        submittedAt: null,
        invalidatedAt: null,
        messageSnapshot: [],
        submitter: null,
        l1IncludedAtUnixSec: null,
      });
      await txn.upsertObserved({
        messageId: null,
        sender: SENDER,
        nonce: 5n,
        contentTag: TAG,
        contents: new Uint8Array(40),
        signature: new Uint8Array(65),
        messageHash: ('0x' + 'ee'.repeat(32)) as Bytes32,
        status: 'confirmed',
        batchRef: ('0x' + '01'.repeat(32)) as Bytes32,
        chainId: 1,
        ingestedAt: null,
        ingestSeq: null,
        blockNumber: 10,
        txIndex: 0,
        messageIndexWithinBatch: 0,
      });
      // Backdoor the tracker into an inconsistent state: claim the
      // last-accepted nonce is 4 even though `messages` covers 5.
      // Mono check will green-light nonce=5 with a different hash;
      // insertPending will then throw DuplicateMessageError.
      await txn.setNonce({
        sender: SENDER,
        lastNonce: 4n,
        lastMessageHash: ('0x' + 'dd'.repeat(32)) as Bytes32,
      });
    });
    const res = await h.pipeline.ingest(signedEnvelope({ nonce: 5n }));
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason).toBe('duplicate');
  });
});

describe('IngestPipeline — contentTag canonicalization', () => {
  it('mixed-case contentTag is canonicalized (lowercase) at ingest so queries match', async () => {
    // Allowlist canonical; envelope ships the same tag in mixed case.
    // Downstream store queries run against the lowercase form, so the
    // row must be inserted under lowercase to be discoverable.
    const mixedCase = ('0x' + 'Aa'.repeat(32)) as Bytes32;
    const h = await mkHarness();
    const raw = signedEnvelope({ tag: mixedCase, signTag: mixedCase });
    const res = await h.pipeline.ingest(raw);
    expect(res.accepted).toBe(true);

    // Canonical (lowercase) query must return the row.
    const rowsLower = await h.store.withTxn(async (txn) => txn.listPendingByTag(TAG));
    expect(rowsLower.length).toBe(1);
  });
});
