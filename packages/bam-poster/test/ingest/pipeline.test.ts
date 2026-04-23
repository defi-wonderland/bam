import { describe, it, expect } from 'vitest';
import {
  bytesToHex,
  computeMessageHash,
  deriveAddress,
  generateECDSAPrivateKey,
  signECDSA,
  type Address,
  type Bytes32,
} from 'bam-sdk';

import { IngestPipeline } from '../../src/ingest/pipeline.js';
import { RateLimiter } from '../../src/ingest/rate-limit.js';
import { MemoryPosterStore } from '../../src/pool/memory-store.js';
import { defaultEcdsaValidator } from '../../src/validator/default-ecdsa.js';
import type { MessageValidator } from '../../src/types.js';

const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const OTHER_TAG = ('0x' + 'bb'.repeat(32)) as Bytes32;

async function signedEnvelope(opts: {
  content?: string;
  nonce?: number;
  timestamp?: number;
  contentTag?: Bytes32;
  privateKey?: string;
}): Promise<{ raw: Uint8Array; author: Address; privateKey: string }> {
  const privateKey = opts.privateKey ?? generateECDSAPrivateKey();
  const author = deriveAddress(privateKey);
  const content = opts.content ?? 'hello';
  const nonce = opts.nonce ?? 1;
  const timestamp = opts.timestamp ?? 1_700_000_000;
  const hash = computeMessageHash({ author, timestamp, nonce, content });
  const sig = await signECDSA(privateKey, bytesToHex(hash) as Bytes32);
  const env = {
    contentTag: opts.contentTag ?? TAG,
    message: {
      author,
      timestamp,
      nonce,
      content,
      signature: bytesToHex(sig),
    },
  };
  return {
    raw: new TextEncoder().encode(JSON.stringify(env)),
    author,
    privateKey,
  };
}

function unsignedGarbage(i: number): Uint8Array {
  const author = ('0x' + ((i + 1).toString(16).padStart(40, '0'))) as Address;
  const env = {
    contentTag: TAG,
    message: {
      author,
      timestamp: 1_700_000_000,
      nonce: 1,
      content: `garbage-${i}`,
      signature: '0x' + '00'.repeat(65),
    },
  };
  return new TextEncoder().encode(JSON.stringify(env));
}

function makePipeline(opts: {
  rateLimit?: { windowMs: number; maxPerWindow: number };
  validator?: MessageValidator;
  maxMessageSizeBytes?: number;
  allowlist?: Bytes32[];
  store?: MemoryPosterStore;
} = {}): { pipeline: IngestPipeline; store: MemoryPosterStore; limiter: RateLimiter } {
  const store = opts.store ?? new MemoryPosterStore();
  const limiter = new RateLimiter(opts.rateLimit ?? { windowMs: 60_000, maxPerWindow: 60 });
  const validator = opts.validator ?? defaultEcdsaValidator();
  const pipeline = new IngestPipeline({
    store,
    validator,
    rateLimiter: limiter,
    allowlistedTags: opts.allowlist ?? [TAG],
    maxMessageSizeBytes: opts.maxMessageSizeBytes ?? 120_000,
    now: () => new Date(0),
  });
  return { pipeline, store, limiter };
}

describe('IngestPipeline — happy path', () => {
  it('accepts a well-formed, signed message and writes a pending row', async () => {
    const { pipeline, store } = makePipeline();
    const { raw, author } = await signedEnvelope({});
    const res = await pipeline.ingest(raw);
    expect(res.accepted).toBe(true);
    const pending = await store.withTxn(async (txn) => txn.listPendingByTag(TAG));
    expect(pending).toHaveLength(1);
    expect(pending[0].author).toBe(author);
    expect(pending[0].nonce).toBe(1n);
  });
});

describe('IngestPipeline — cheap gates before crypto', () => {
  it('CPU-grief ordering: rate-limit fires before the validator is invoked', async () => {
    let verifyCount = 0;
    const realEcdsa = defaultEcdsaValidator();
    const countingValidator: MessageValidator = {
      validate(m) {
        verifyCount++;
        return realEcdsa.validate(m);
      },
      recoverSigner: realEcdsa.recoverSigner?.bind(realEcdsa),
    };
    // Fixed author (all garbage uses i=0) so rate-limit accumulates
    // against the same key.
    const { pipeline } = makePipeline({
      validator: countingValidator,
      rateLimit: { windowMs: 60_000, maxPerWindow: 3 },
    });

    for (let i = 0; i < 1000; i++) {
      // Same key (i=0) every call — rate-limit must fire on calls 4..1000.
      await pipeline.ingest(unsignedGarbage(0));
    }
    // Validator budget: exactly `maxPerWindow` attempts reach the
    // signature check before rate-limit absorbs the rest.
    expect(verifyCount).toBeLessThanOrEqual(3);
  });

  it('rate-limit keys on recovered signer — rotating claimed author does not multiply budget', async () => {
    // One real signing key, N rotating claimed-author values. Each
    // envelope signs against the real key (so recovery yields the
    // same address every time) while the envelope's `author` field
    // rotates — the bypass cubic flagged: pre-fix, every rotation
    // would land in a fresh rate-limit bucket. Post-fix, recovery
    // collapses them into one bucket.
    const { pipeline } = makePipeline({
      rateLimit: { windowMs: 60_000, maxPerWindow: 2 },
    });
    const privateKey = generateECDSAPrivateKey();
    const realAuthor = deriveAddress(privateKey);
    const timestamp = 1_700_000_000;

    // Build N envelopes that all recover to `realAuthor` but declare
    // a rotating claimed author. They'll fail the ECDSA verify (since
    // claimed != recovered) — but that's after monotonicity and after
    // the rate-limit check. Rate-limit must still absorb them.
    const envelopes: Uint8Array[] = [];
    for (let i = 0; i < 20; i++) {
      const claimedAuthor = ('0x' + (i + 1).toString(16).padStart(40, '0')) as Address;
      const hash = computeMessageHash({ author: realAuthor, timestamp, nonce: i + 1, content: 'x' });
      const sig = await signECDSA(privateKey, bytesToHex(hash) as Bytes32);
      const env = {
        contentTag: TAG,
        message: {
          author: claimedAuthor,
          timestamp,
          nonce: i + 1,
          content: 'x',
          signature: bytesToHex(sig),
        },
      };
      envelopes.push(new TextEncoder().encode(JSON.stringify(env)));
    }

    let rateLimited = 0;
    for (const raw of envelopes) {
      const res = await pipeline.ingest(raw);
      if (!res.accepted && res.reason === 'rate_limited') rateLimited++;
    }
    // maxPerWindow=2 ⇒ 18 of the 20 must be rate-limited.
    expect(rateLimited).toBe(18);
  });

  it('rejects oversized payloads before parsing', async () => {
    const { pipeline } = makePipeline({ maxMessageSizeBytes: 10 });
    const res = await pipeline.ingest(new Uint8Array(100));
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason).toBe('message_too_large');
  });

  it('rejects transport-hint disagreement with content_tag_mismatch', async () => {
    const { pipeline } = makePipeline();
    const { raw } = await signedEnvelope({});
    const res = await pipeline.ingest(raw, { contentTag: OTHER_TAG });
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason).toBe('content_tag_mismatch');
  });

  it('rejects unknown tags (unknown_tag)', async () => {
    const { pipeline } = makePipeline({ allowlist: [OTHER_TAG] });
    const { raw } = await signedEnvelope({ contentTag: TAG });
    const res = await pipeline.ingest(raw);
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason).toBe('unknown_tag');
  });

  it('custom recoverSigner that throws is contained (qodo review)', async () => {
    // A custom validator whose recoverSigner throws must not escape the
    // pipeline as an uncaught error — the contract is to return a
    // PosterRejection. We treat it as recover-mismatch so rate-limit
    // routes to the sentinel bucket.
    const realEcdsa = defaultEcdsaValidator();
    const throwingValidator: MessageValidator = {
      validate(m) {
        return realEcdsa.validate(m);
      },
      recoverSigner() {
        throw new Error('boom');
      },
    };
    const { pipeline } = makePipeline({
      validator: throwingValidator,
      rateLimit: { windowMs: 60_000, maxPerWindow: 2 },
    });
    const { raw } = await signedEnvelope({});
    // The throw must not bubble; first two calls land in the sentinel
    // bucket and succeed (validator.validate runs next and accepts the
    // good signature), third gets rate-limited.
    const results = await Promise.all([
      pipeline.ingest(raw),
      pipeline.ingest(await signedEnvelope({ nonce: 2 }).then((e) => e.raw)),
      pipeline.ingest(await signedEnvelope({ nonce: 3 }).then((e) => e.raw)),
    ]);
    // Exactly one rate_limited reject among the three.
    const rejections = results.filter((r) => !r.accepted);
    expect(rejections).toHaveLength(1);
    if (!rejections[0].accepted) expect(rejections[0].reason).toBe('rate_limited');
  });
});

describe('IngestPipeline — nonce monotonicity', () => {
  it('byte-equal resubmit is a no-op (returns the original id)', async () => {
    const { pipeline } = makePipeline();
    const { raw } = await signedEnvelope({ nonce: 3 });
    const r1 = await pipeline.ingest(raw);
    const r2 = await pipeline.ingest(raw);
    expect(r1.accepted).toBe(true);
    expect(r2.accepted).toBe(true);
    if (r1.accepted && r2.accepted) {
      expect(r2.messageId).toBe(r1.messageId);
    }
  });

  it('rejects equal-nonce with different content as stale_nonce', async () => {
    const { pipeline } = makePipeline();
    const privateKey = generateECDSAPrivateKey();
    const e1 = await signedEnvelope({ nonce: 1, content: 'first', privateKey });
    const e2 = await signedEnvelope({ nonce: 1, content: 'second', privateKey });
    const r1 = await pipeline.ingest(e1.raw);
    const r2 = await pipeline.ingest(e2.raw);
    expect(r1.accepted).toBe(true);
    expect(r2.accepted).toBe(false);
    if (!r2.accepted) expect(r2.reason).toBe('stale_nonce');
  });

  it('rejects strictly-lesser nonce', async () => {
    const { pipeline } = makePipeline();
    const privateKey = generateECDSAPrivateKey();
    const e1 = await signedEnvelope({ nonce: 5, privateKey });
    const e2 = await signedEnvelope({ nonce: 4, privateKey });
    const r1 = await pipeline.ingest(e1.raw);
    const r2 = await pipeline.ingest(e2.raw);
    expect(r1.accepted).toBe(true);
    expect(r2.accepted).toBe(false);
    if (!r2.accepted) expect(r2.reason).toBe('stale_nonce');
  });
});

describe('IngestPipeline — atomicity race (plan §C-3)', () => {
  it('50 parallel submits of identical (sender,nonce,content) produce exactly one acceptance', async () => {
    const { pipeline, store } = makePipeline();
    const { raw } = await signedEnvelope({});
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, () => pipeline.ingest(raw))
    );
    // Every result should be "accepted" because the byte-equal retry
    // is a no-op (returns the same id). But exactly one row must exist
    // in the pool, and exactly one (author, nonce) entry in the nonce
    // tracker.
    const pending = await store.withTxn(async (txn) => txn.listPendingByTag(TAG));
    expect(pending).toHaveLength(1);
    const accepts = results.filter((r) => r.accepted);
    expect(accepts.length).toBe(N);
    const ids = new Set(accepts.filter((r) => r.accepted).map((r) => (r as { messageId: string }).messageId));
    expect(ids.size).toBe(1);
  });

  it('50 parallel submits with same (sender, nonce) but different content: exactly one accepted', async () => {
    const { pipeline, store } = makePipeline();
    const privateKey = generateECDSAPrivateKey();
    const N = 50;
    const envelopes = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        signedEnvelope({ nonce: 1, content: `variant-${i}`, privateKey })
      )
    );
    const results = await Promise.all(envelopes.map((e) => pipeline.ingest(e.raw)));
    const accepted = results.filter((r) => r.accepted);
    const rejected = results.filter((r) => !r.accepted);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(N - 1);
    for (const r of rejected) {
      if (!r.accepted) expect(r.reason).toBe('stale_nonce');
    }
    const pending = await store.withTxn(async (txn) => txn.listPendingByTag(TAG));
    expect(pending).toHaveLength(1);
  });
});

describe('IngestPipeline — malformed envelopes', () => {
  it('rejects non-JSON bytes with malformed', async () => {
    const { pipeline } = makePipeline();
    const res = await pipeline.ingest(new Uint8Array([0xff, 0xff, 0xff]));
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason).toBe('malformed');
  });

  it('rejects an envelope with a bad contentTag shape', async () => {
    const { pipeline } = makePipeline();
    const bad = new TextEncoder().encode(
      JSON.stringify({ contentTag: 'notatag', message: {} })
    );
    const res = await pipeline.ingest(bad);
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason).toBe('malformed');
  });

  it('rejects non-integer / unsafe-integer timestamps (cubic review)', async () => {
    // `Number.isFinite` previously accepted floats and values above
    // MAX_SAFE_INTEGER. Both would silently coerce during uint64
    // packing and break signature verification in subtle ways.
    const { pipeline } = makePipeline();
    const badTimestamps = [1_700_000_000.5, Number.MAX_SAFE_INTEGER + 2, -1, Number.POSITIVE_INFINITY];
    for (const ts of badTimestamps) {
      const env = {
        contentTag: TAG,
        message: {
          author: '0x1111111111111111111111111111111111111111',
          timestamp: ts,
          nonce: 1,
          content: 'x',
          signature: '0x' + '00'.repeat(65),
        },
      };
      const raw = new TextEncoder().encode(JSON.stringify(env));
      const res = await pipeline.ingest(raw);
      expect(res.accepted).toBe(false);
      if (!res.accepted) expect(res.reason).toBe('malformed');
    }
  });
});

describe('IngestPipeline — nonce parsing (cubic review)', () => {
  it('parses decimal-string nonces as decimal, not hex', async () => {
    const { pipeline, store } = makePipeline();
    // Sign for nonce 10 (decimal ten), serialize nonce as the
    // string "10" (what most JSON producers will do).
    const privateKey = generateECDSAPrivateKey();
    const author = deriveAddress(privateKey);
    const timestamp = 1_700_000_000;
    const nonce = 10;
    const content = 'ten';
    const hash = computeMessageHash({ author, timestamp, nonce, content });
    const sig = await signECDSA(privateKey, bytesToHex(hash) as Bytes32);
    const env = {
      contentTag: TAG,
      message: {
        author,
        timestamp,
        nonce: '10', // decimal string — must parse as 10, not 16
        content,
        signature: bytesToHex(sig),
      },
    };
    const raw = new TextEncoder().encode(JSON.stringify(env));
    const res = await pipeline.ingest(raw);
    expect(res.accepted).toBe(true);
    const pending = await store.withTxn(async (txn) => txn.listPendingByTag(TAG));
    expect(pending).toHaveLength(1);
    expect(pending[0].nonce).toBe(10n);
  });

  it('parses 0x-prefixed hex strings as hex', async () => {
    const { pipeline, store } = makePipeline();
    const privateKey = generateECDSAPrivateKey();
    const author = deriveAddress(privateKey);
    const timestamp = 1_700_000_000;
    const nonce = 16; // 0x10
    const content = 'sixteen';
    const hash = computeMessageHash({ author, timestamp, nonce, content });
    const sig = await signECDSA(privateKey, bytesToHex(hash) as Bytes32);
    const env = {
      contentTag: TAG,
      message: {
        author,
        timestamp,
        nonce: '0x10', // explicit hex
        content,
        signature: bytesToHex(sig),
      },
    };
    const raw = new TextEncoder().encode(JSON.stringify(env));
    const res = await pipeline.ingest(raw);
    expect(res.accepted).toBe(true);
    const pending = await store.withTxn(async (txn) => txn.listPendingByTag(TAG));
    expect(pending[0].nonce).toBe(16n);
  });
});

describe('IngestPipeline — contentTag case normalization (qodo review)', () => {
  it('persists mixed-case envelope tags under a canonical lowercase form', async () => {
    // Allowlist is lowercase; envelope sends the tag in uppercase. The
    // store adapters match tags case-sensitively, so without
    // canonicalization the per-tag worker query would never see the
    // inserted row and messages would stall indefinitely.
    const { pipeline, store } = makePipeline();
    const upperTag = ('0x' + 'AA'.repeat(32)) as Bytes32;
    const { raw } = await signedEnvelope({ contentTag: upperTag });

    const res = await pipeline.ingest(raw);
    expect(res.accepted).toBe(true);

    // Query using the canonical lowercase tag — must find the row.
    const pending = await store.withTxn(async (txn) =>
      txn.listPendingByTag(TAG)
    );
    expect(pending).toHaveLength(1);
    expect(pending[0].contentTag).toBe(TAG);
  });
});
