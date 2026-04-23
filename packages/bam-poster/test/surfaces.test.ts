import { describe, it, expect } from 'vitest';
import type { Address, Bytes32 } from 'bam-sdk';

import { MemoryPosterStore } from '../src/pool/memory-store.js';
import { LocalEcdsaSigner } from '../src/signer/local.js';
import { readHealth } from '../src/surfaces/health.js';
import { listPending } from '../src/surfaces/pending.js';
import { readStatus } from '../src/surfaces/status.js';
import { listSubmittedBatches } from '../src/surfaces/submitted.js';
import type { MessageSnapshot, Status } from '../src/types.js';

const TAG_A = ('0x' + 'aa'.repeat(32)) as Bytes32;
const TAG_B = ('0x' + 'bb'.repeat(32)) as Bytes32;
const AUTHOR = '0x1111111111111111111111111111111111111111' as Address;

describe('surfaces — disjointness (plan §C-9)', () => {
  it('status and health expose disjoint field sets', async () => {
    const store = new MemoryPosterStore();
    const signer = new LocalEcdsaSigner(('0x' + 'ab'.repeat(32)) as `0x${string}`);
    const status = await readStatus({
      store,
      rpc: { async getBalance() { return 123n; } },
      signer,
      configuredTags: [TAG_A, TAG_B],
    });
    const health = readHealth({ submissionState: 'degraded', reason: 'RPC slow' });

    const statusKeys = new Set(Object.keys(status));
    const healthKeys = new Set(Object.keys(health));
    for (const k of statusKeys) expect(healthKeys.has(k)).toBe(false);
    for (const k of healthKeys) expect(statusKeys.has(k)).toBe(false);
  });

  it('status exposes balances + tags + counts + last-submitted (quantitative)', async () => {
    const store = new MemoryPosterStore();
    const signer = new LocalEcdsaSigner(('0x' + 'ab'.repeat(32)) as `0x${string}`);
    const status = await readStatus({
      store,
      rpc: { async getBalance() { return 10n ** 18n; } },
      signer,
      configuredTags: [TAG_A, TAG_B],
    });
    expect(status.walletAddress).toMatch(/^0x/);
    expect(status.walletBalanceWei).toBe(10n ** 18n);
    expect(status.configuredTags).toEqual([TAG_A, TAG_B]);
    expect(status.pendingByTag.length).toBe(2);
    // No last-submitted yet.
    expect(status.lastSubmittedByTag).toEqual([]);
  });

  it('health reports state/reason/since only (qualitative)', () => {
    const now = new Date(1_700_000_000_000);
    const health = readHealth({
      submissionState: 'degraded',
      reason: 'wallet balance low',
      since: now,
    });
    expect(health.state).toBe('degraded');
    expect(health.reason).toBe('wallet balance low');
    expect(health.since).toBe(now);
    expect((health as unknown as Status).walletBalanceWei).toBeUndefined();
  });

  it('ok health omits reason + since', () => {
    expect(readHealth({ submissionState: 'ok' })).toEqual({ state: 'ok' });
  });
});

describe('surfaces — listPending', () => {
  it('filters by contentTag', async () => {
    const store = new MemoryPosterStore();
    await store.withTxn(async (txn) => {
      for (const [i, tag] of [[1, TAG_A], [2, TAG_B], [3, TAG_A]] as const) {
        await txn.insertPending({
          messageId: (`0x${i.toString(16).padStart(64, '0')}`) as Bytes32,
          contentTag: tag,
          author: AUTHOR,
          nonce: BigInt(i),
          timestamp: 1_700_000_000 + i,
          content: new TextEncoder().encode(`msg-${i}`),
          signature: new Uint8Array(65),
          ingestedAt: 1_700_000_000_000 + i,
          ingestSeq: await txn.nextIngestSeq(tag),
        });
      }
    });
    const a = await listPending(store, { contentTag: TAG_A });
    expect(a).toHaveLength(2);
    expect(a.every((m) => m.contentTag === TAG_A)).toBe(true);
    const b = await listPending(store, { contentTag: TAG_B });
    expect(b).toHaveLength(1);
    const all = await listPending(store, {});
    expect(all).toHaveLength(3);
  });

  it('respects limit + since cursor', async () => {
    const store = new MemoryPosterStore();
    await store.withTxn(async (txn) => {
      for (let i = 1; i <= 5; i++) {
        await txn.insertPending({
          messageId: (`0x${i.toString(16).padStart(64, '0')}`) as Bytes32,
          contentTag: TAG_A,
          author: AUTHOR,
          nonce: BigInt(i),
          timestamp: 1_700_000_000 + i,
          content: new TextEncoder().encode(`msg-${i}`),
          signature: new Uint8Array(65),
          ingestedAt: 1_700_000_000_000 + i,
          ingestSeq: i,
        });
      }
    });
    const limited = await listPending(store, { contentTag: TAG_A, limit: 2 });
    expect(limited.map((m) => m.ingestSeq)).toEqual([1, 2]);
    const after = await listPending(store, {
      contentTag: TAG_A,
      since: { ingestSeq: 2, contentTag: TAG_A },
    });
    expect(after.map((m) => m.ingestSeq)).toEqual([3, 4, 5]);
  });
});

describe('surfaces — listSubmittedBatches', () => {
  it('returns reorg status + replacedByTxHash where applicable', async () => {
    const store = new MemoryPosterStore();
    const messageIds = [('0x' + '11'.repeat(32)) as Bytes32];
    const messages: MessageSnapshot[] = [];
    await store.withTxn(async (txn) => {
      await txn.insertSubmitted({
        txHash: ('0x' + 'aa'.repeat(32)) as Bytes32,
        contentTag: TAG_A,
        blobVersionedHash: ('0x' + '00'.repeat(32)) as Bytes32,
        blockNumber: 100,
        status: 'reorged',
        replacedByTxHash: ('0x' + 'bb'.repeat(32)) as Bytes32,
        submittedAt: 1_700_000_000_000,
        messageIds,
        messages,
      });
      await txn.insertSubmitted({
        txHash: ('0x' + 'bb'.repeat(32)) as Bytes32,
        contentTag: TAG_A,
        blobVersionedHash: ('0x' + '00'.repeat(32)) as Bytes32,
        blockNumber: 120,
        status: 'included',
        replacedByTxHash: null,
        submittedAt: 1_700_000_000_001,
        messageIds,
        messages,
      });
    });
    const batches = await listSubmittedBatches(store, { contentTag: TAG_A });
    expect(batches).toHaveLength(2);
    const reorged = batches.find((b) => b.status === 'reorged');
    expect(reorged?.replacedByTxHash).toBe(('0x' + 'bb'.repeat(32)) as Bytes32);
  });
});
