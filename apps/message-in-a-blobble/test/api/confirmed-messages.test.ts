import {
  computeMessageHashForMessage,
  computeMessageId,
  deriveAddress,
  encodeContents,
  generateECDSAPrivateKey,
  hexToBytes,
  signECDSAWithKey,
} from 'bam-sdk';
import type { Address, BAMMessage, Bytes32 } from 'bam-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MESSAGE_IN_A_BLOBBLE_TAG } from '@/lib/constants';

const CHAIN_ID = 11155111;

interface SignedMessage {
  message: BAMMessage;
  signature: Uint8Array;
  messageHash: Bytes32;
}

function makeSignedMessage(nonce: bigint, payload: Uint8Array): SignedMessage {
  const priv = generateECDSAPrivateKey();
  const sender = deriveAddress(priv);
  const contents = encodeContents(MESSAGE_IN_A_BLOBBLE_TAG as Bytes32, payload);
  const message: BAMMessage = { sender, nonce, contents };
  const sigHex = signECDSAWithKey(priv, message, CHAIN_ID);
  return {
    message,
    signature: hexToBytes(sigHex),
    messageHash: computeMessageHashForMessage(message),
  };
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '0x';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

describe('GET /api/confirmed-messages — bam-store source', () => {
  beforeEach(() => {
    // Force the in-process PGLite path so each test gets an isolated
    // store after `_clearBamStoreForTests()` resets the lazy singleton.
    delete process.env.BAM_STORE_POSTGRES_URL;
    delete process.env.POSTGRES_URL;
  });

  afterEach(async () => {
    const { _clearBamStoreForTests } = await import(
      '@/lib/bam-store-client'
    );
    await _clearBamStoreForTests();
  });

  it('returns Reader-populated confirmed rows mapped to the legacy ConfirmedRow shape', async () => {
    const { getBamStore } = await import('@/lib/bam-store-client');
    const store = await getBamStore();
    const m1 = makeSignedMessage(1n, new TextEncoder().encode('hello world'));
    const m2 = makeSignedMessage(
      2n,
      new TextEncoder().encode('second message')
    );
    const txHash = ('0x' + 'aa'.repeat(32)) as Bytes32;
    const versionedHash = ('0x01' + 'bb'.repeat(31)) as Bytes32;

    await store.withTxn(async (txn) => {
      await txn.upsertBatch({
        txHash,
        chainId: CHAIN_ID,
        contentTag: MESSAGE_IN_A_BLOBBLE_TAG as Bytes32,
        blobVersionedHash: versionedHash,
        batchContentHash: versionedHash,
        blockNumber: 100,
        txIndex: 0,
        status: 'confirmed',
        replacedByTxHash: null,
        submittedAt: null,
        invalidatedAt: null,
        messageSnapshot: [],
      });
      for (const [i, sm] of [m1, m2].entries()) {
        await txn.upsertObserved({
          messageId: computeMessageId(
            sm.message.sender,
            sm.message.nonce,
            versionedHash
          ),
          author: sm.message.sender,
          nonce: sm.message.nonce,
          contentTag: MESSAGE_IN_A_BLOBBLE_TAG as Bytes32,
          contents: new Uint8Array(sm.message.contents),
          signature: new Uint8Array(sm.signature),
          messageHash: sm.messageHash,
          status: 'confirmed',
          batchRef: txHash,
          ingestedAt: null,
          ingestSeq: null,
          blockNumber: 100,
          txIndex: 0,
          messageIndexWithinBatch: i,
        });
      }
    });

    const { GET } = await import(
      '../../src/app/api/confirmed-messages/route'
    );
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<Record<string, unknown>> };
    expect(body.messages.length).toBe(2);
    const rowFor1 = body.messages.find((m) => m.nonce === '1');
    expect(rowFor1).toMatchObject({
      sender: m1.message.sender,
      nonce: '1',
      contents: bytesToHex(m1.message.contents),
      signature: bytesToHex(m1.signature),
      tx_hash: txHash,
      block_number: 100,
      blobble_id: txHash.slice(0, 18),
      status: 'posted',
    });
  });

  it('omits non-confirmed rows', async () => {
    const { getBamStore } = await import('@/lib/bam-store-client');
    const store = await getBamStore();
    const m = makeSignedMessage(7n, new Uint8Array([0xff]));
    await store.withTxn(async (txn) => {
      await txn.upsertObserved({
        messageId: null,
        author: m.message.sender,
        nonce: m.message.nonce,
        contentTag: MESSAGE_IN_A_BLOBBLE_TAG as Bytes32,
        contents: new Uint8Array(m.message.contents),
        signature: new Uint8Array(m.signature),
        messageHash: m.messageHash,
        status: 'pending',
        batchRef: null,
        ingestedAt: 0,
        ingestSeq: 1,
        blockNumber: null,
        txIndex: null,
        messageIndexWithinBatch: null,
      });
    });

    const { GET } = await import(
      '../../src/app/api/confirmed-messages/route'
    );
    const res = await GET();
    const body = (await res.json()) as { messages: unknown[] };
    expect(body.messages).toEqual([]);
  });

  it('returns 502 when the store backend is unreachable', async () => {
    // Point at an unreachable Postgres so `createDbStore` rejects when
    // it tries to bootstrap. localhost:1 refuses TCP fast, so the
    // failure surfaces immediately rather than after a multi-second
    // connect timeout.
    process.env.BAM_STORE_POSTGRES_URL = 'postgres://nobody@127.0.0.1:1/none';
    const { _clearBamStoreForTests } = await import(
      '@/lib/bam-store-client'
    );
    _clearBamStoreForTests();
    try {
      const { GET } = await import(
        '../../src/app/api/confirmed-messages/route'
      );
      const res = await GET();
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('bam_store_unreachable');
    } finally {
      delete process.env.BAM_STORE_POSTGRES_URL;
    }
  });
});
