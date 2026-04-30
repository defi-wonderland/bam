/**
 * Triggered-but-excluded steady-state e2e (T029, B-1).
 *
 * Runs hermetically against an in-memory store: drives a "Social" tag
 * whose selected batch fills the blob alone, plus a "Forum" tag whose
 * messages are always selectable but never fit. Asserts:
 *
 *   - Forum's `packingLossStreak` grows monotonically while Social
 *     dominates capacity (oldest-first arbitration always picks Social).
 *   - The aggregator does NOT crash and does NOT halt.
 *   - When Social goes idle, Forum lands and its streak resets to 0.
 *
 * The acceptance-criterion shape comes from `spec.md`'s
 * "triggered-but-excluded steady state" goal — unbounded deferral is
 * the documented behavior; the streak counter is the operator signal.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  computeMessageHashForMessage,
  deriveAddress,
  encodeBatch,
  encodeContents,
  generateECDSAPrivateKey,
  hexToBytes,
  loadTrustedSetup,
  signECDSAWithKey,
  USABLE_BYTES_PER_FIELD_ELEMENT,
  type Address,
  type BAMMessage,
  type Bytes32,
} from 'bam-sdk';
import { createMemoryStore, type BamStore } from 'bam-store';

import { AggregatorLoop } from '../../src/submission/aggregator-loop.js';
import { DEFAULT_BACKOFF } from '../../src/submission/backoff.js';
import type {
  BuildAndSubmitMulti,
  PackedSubmitOutcome,
} from '../../src/submission/types.js';

beforeAll(() => {
  loadTrustedSetup();
});

const CHAIN_ID = 31337;
const SOCIAL = ('0x' + 'a1'.repeat(32)) as Bytes32;
const FORUM = ('0x' + 'a2'.repeat(32)) as Bytes32;

const stores: BamStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

async function newStore(): Promise<BamStore> {
  const s = await createMemoryStore();
  stores.push(s);
  return s;
}

async function ingestSized(
  store: BamStore,
  tag: Bytes32,
  count: number,
  payloadBytes: number,
  ingestedAt: number
): Promise<void> {
  await store.withTxn(async (txn) => {
    for (let i = 0; i < count; i++) {
      const priv = generateECDSAPrivateKey();
      const sender = deriveAddress(priv);
      const payload = new Uint8Array(payloadBytes);
      payload.fill(0xa0 + (i & 0x0f));
      const contents = encodeContents(tag, payload);
      const message: BAMMessage = { sender, nonce: 1n, contents };
      const sigHex = signECDSAWithKey(priv, message, CHAIN_ID);
      const signature = hexToBytes(sigHex);
      const messageHash = computeMessageHashForMessage(message);
      const ingestSeq = await txn.nextIngestSeq(tag);
      await txn.insertPending({
        contentTag: tag,
        sender,
        nonce: 1n,
        contents,
        signature,
        messageHash,
        ingestedAt: ingestedAt + i,
        ingestSeq,
      });
    }
  });
}

const alwaysFire = {
  select(tag: Bytes32, pool: { list: (t: Bytes32) => readonly any[] }) {
    const msgs = pool.list(tag);
    if (msgs.length === 0) return null;
    return { msgs: [...msgs] };
  },
};

function bytes32(label: string, n: number): Bytes32 {
  const hex = (label + n.toString(16)).padStart(64, '0');
  return ('0x' + hex) as Bytes32;
}

function makeBuildAndSubmit(): { multi: BuildAndSubmitMulti; round: () => number } {
  let round = 0;
  const multi: BuildAndSubmitMulti = async ({ pack }) => {
    round += 1;
    const outcome: PackedSubmitOutcome = {
      kind: 'included',
      txHash: bytes32('cc', round),
      blockNumber: 100 + round,
      txIndex: 0,
      blobVersionedHash: bytes32('01', round),
      submitter: ('0x' + '11'.repeat(20)) as Address,
      entries: pack.plan.included.map((seg) => {
        const sel = pack.includedSelections.get(seg.contentTag)!;
        return {
          contentTag: seg.contentTag,
          startFE: seg.startFE,
          endFE: seg.endFE,
          messages: sel.messages,
        };
      }),
    };
    return outcome;
  };
  return { multi, round: () => round };
}

describe('triggered-but-excluded steady state (T029)', () => {
  it("Forum's streak grows while Social dominates, resets when Social goes idle", async () => {
    const store = await newStore();
    const { multi } = makeBuildAndSubmit();

    // Use a stubbed encoder that produces a deterministic byte length
    // per tag so the planner's FE math is reproducible:
    //   Social → 1500 bytes (49 FEs)
    //   Forum  →  300 bytes (10 FEs)
    // Capacity 50 FEs / 1550 bytes → Social fits alone (49 FEs);
    // Forum's 10 FEs would push the aggregate to 59 > 50 → excluded.
    const SOCIAL_BYTES = 1_500;
    const FORUM_BYTES = 300;
    const stubEncoder = (msgs: BAMMessage[]) => {
      // Tag is encoded inside each message's contents prefix; pick the
      // payload size by the first tag we see.
      const tag = msgs[0]?.contents?.subarray(0, 32);
      if (tag === undefined) return { data: new Uint8Array(0) };
      const tagHex = '0x' + Array.from(tag).map((b) => b.toString(16).padStart(2, '0')).join('');
      const len = tagHex === SOCIAL ? SOCIAL_BYTES : FORUM_BYTES;
      return { data: new Uint8Array(len) };
    };

    // Round 1: both tags have data. Social ingested at t=1000,
    // Forum at t=2000 — Social is oldest, lands. Forum streak 0→1.
    //
    // For each subsequent round we re-ingest Social with a timestamp
    // *older* than Forum's lingering message so oldest-first
    // arbitration keeps picking Social. This mirrors the spec's
    // "Social keeps ingesting continuously, accumulating older
    // pending messages" steady state — Forum's age trigger fires,
    // its batch never fits, its streak grows.
    await ingestSized(store, SOCIAL, 1, 100, 1_000);
    await ingestSized(store, FORUM, 1, 50, 2_000);

    const loop = new AggregatorLoop({
      tags: [SOCIAL, FORUM],
      chainId: CHAIN_ID,
      store,
      policy: alwaysFire,
      blobCapacityBytes: 50 * USABLE_BYTES_PER_FIELD_ELEMENT,
      buildAndSubmitMulti: multi,
      backoff: DEFAULT_BACKOFF,
      now: () => new Date(10_000),
      reorgWindowBlocks: 32,
      capacityFEs: 50,
      capacityBytes: 1_550,
      maxTagsPerPack: 8,
      encodeBatch: stubEncoder,
    } as any);

    expect(await loop.tick()).toBe('success');
    let snap = loop.packingLossSnapshot();
    let forum = snap.find((s) => s.contentTag === FORUM)!;
    expect(forum.packingLossStreak).toBe(1);

    // Round 2: Social re-ingested at t=500 (older than Forum's
    // lingering message at t=2000). Social wins again; Forum 1→2.
    await ingestSized(store, SOCIAL, 1, 100, 500);
    expect(await loop.tick()).toBe('success');
    snap = loop.packingLossSnapshot();
    forum = snap.find((s) => s.contentTag === FORUM)!;
    expect(forum.packingLossStreak).toBe(2);

    // Round 3: Social ingested at t=200. Forum 2→3.
    await ingestSized(store, SOCIAL, 1, 100, 200);
    expect(await loop.tick()).toBe('success');
    snap = loop.packingLossSnapshot();
    forum = snap.find((s) => s.contentTag === FORUM)!;
    expect(forum.packingLossStreak).toBe(3);

    // Aggregator did NOT crash and Social keeps submitting.
    expect(loop.isPermanentlyStopped()).toBe(false);

    // Round 4: Social is idle — Forum finally lands; streak resets.
    expect(await loop.tick()).toBe('success');
    snap = loop.packingLossSnapshot();
    forum = snap.find((s) => s.contentTag === FORUM)!;
    expect(forum.packingLossStreak).toBe(0);
    expect(forum.lastIncludedAt).toBe(10_000);
  });
});
