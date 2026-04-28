/**
 * Malicious-registry / eth_call DoS test (red-team C-10, gate G-7).
 *
 * Two malicious-registry shapes:
 *   1. Verify call hangs past the configured wallclock timeout — the
 *      dispatch's `Promise.race` should resolve `false` (skip) and let
 *      the loop continue.
 *   2. Verify call throws a "gas exceeds allowance"-shaped error — the
 *      dispatch should classify it as `gas_cap`, return `false`, and
 *      let the loop continue.
 *
 * In both shapes, no `MessageRow` lands as `confirmed`, the
 * `skippedVerify` counter increments, and the loop's next batch
 * (under the same registry) is processed without halt.
 */

import {
  computeMessageHashForMessage,
  deriveAddress,
  encodeContents,
  generateECDSAPrivateKey,
  hexToBytes,
  signECDSAWithKey,
} from 'bam-sdk';
import type { Address, BAMMessage, Bytes32 } from 'bam-sdk';
import { createMemoryStore } from 'bam-store';
import { describe, expect, it } from 'vitest';

import { processBatch, emptyCounters } from '../../src/loop/process-batch.js';
import type { BlobBatchRegisteredEvent } from '../../src/discovery/log-scan.js';
import type { VerifyReadContractClient } from '../../src/verify/on-chain-registry.js';

const CHAIN_ID = 11155111;
const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const MALICIOUS_REGISTRY = '0x000000000000000000000000000000000000beef' as Address;

interface SignedMessage {
  message: BAMMessage;
  signature: Uint8Array;
  messageHash: Bytes32;
}

function makeSignedMessage(nonce: bigint, payload: Uint8Array): SignedMessage {
  const priv = generateECDSAPrivateKey();
  const sender = deriveAddress(priv);
  const message: BAMMessage = {
    sender,
    nonce,
    contents: encodeContents(TAG, payload),
  };
  const sigHex = signECDSAWithKey(priv, message, CHAIN_ID);
  return {
    message,
    signature: hexToBytes(sigHex),
    messageHash: computeMessageHashForMessage(message),
  };
}

const FAKE_BLOB = new Uint8Array(4096 * 32);

function makeEvent(opts: { txHash: Bytes32; signatureRegistry: Address; block: number }): BlobBatchRegisteredEvent {
  return {
    blockNumber: opts.block,
    txIndex: 0,
    logIndex: 0,
    txHash: opts.txHash,
    versionedHash: ('0x01' + opts.block.toString(16).padStart(2, '0').repeat(31)) as Bytes32,
    submitter: '0x000000000000000000000000000000000000ab12' as Address,
    contentTag: TAG,
    decoder: ZERO_ADDRESS,
    signatureRegistry: opts.signatureRegistry,
  };
}

describe('malicious-registry eth_call DoS', () => {
  it('treats a hanging registry call as per-message skip + continues to the next batch', async () => {
    const store = await createMemoryStore();
    const counters = emptyCounters();
    const m1 = makeSignedMessage(1n, new Uint8Array([1]));
    const m2 = makeSignedMessage(2n, new Uint8Array([2]));

    // Registry that NEVER returns — dispatch's wallclock timeout must fire.
    const hangingClient: VerifyReadContractClient = {
      async readContract() {
        return new Promise(() => {}); // never resolves
      },
    };

    // Process two batches under the malicious registry.
    for (const tx of [
      ('0x' + '01'.repeat(32)) as Bytes32,
      ('0x' + '02'.repeat(32)) as Bytes32,
    ]) {
      await processBatch({
        event: makeEvent({
          txHash: tx,
          signatureRegistry: MALICIOUS_REGISTRY,
          block: 100,
        }),
        parentBeaconBlockRoot: null,
        store,
        sources: {},
        chainId: CHAIN_ID,
        verifyPublicClient: hangingClient,
        ethCallGasCap: 50_000_000n,
        ethCallTimeoutMs: 25, // bound — test fires fast
        counters,
        fetchBlob: async () => FAKE_BLOB,
        decode: async () => ({ messages: [m1.message, m2.message], signatures: [m1.signature, m2.signature] }),
      });
    }

    // No MessageRow landed as confirmed.
    const rows = await store.withTxn((txn) => txn.listMessages({ contentTag: TAG }));
    expect(rows.length).toBe(0);
    // skippedVerify incremented for every per-message verify (2 batches × 2 messages = 4).
    expect(counters.skippedVerify).toBe(4);
    expect(counters.decoded).toBe(0);
  });

  it('treats a "gas exceeds allowance" revert as per-message skip + continues', async () => {
    const store = await createMemoryStore();
    const counters = emptyCounters();
    const m = makeSignedMessage(1n, new Uint8Array([1]));

    const gasCapClient: VerifyReadContractClient = {
      async readContract() {
        throw new Error('intrinsic gas exceeds gas allowance');
      },
    };

    // Two batches in sequence under the gas-cap-tripping registry.
    for (const tx of [
      ('0x' + '11'.repeat(32)) as Bytes32,
      ('0x' + '22'.repeat(32)) as Bytes32,
    ]) {
      await processBatch({
        event: makeEvent({
          txHash: tx,
          signatureRegistry: MALICIOUS_REGISTRY,
          block: 100,
        }),
        parentBeaconBlockRoot: null,
        store,
        sources: {},
        chainId: CHAIN_ID,
        verifyPublicClient: gasCapClient,
        ethCallGasCap: 50_000_000n,
        ethCallTimeoutMs: 5_000,
        counters,
        fetchBlob: async () => FAKE_BLOB,
        decode: async () => ({ messages: [m.message], signatures: [m.signature] }),
      });
    }

    const rows = await store.withTxn((txn) => txn.listMessages({ contentTag: TAG }));
    expect(rows.length).toBe(0);
    expect(counters.skippedVerify).toBe(2);
    // Both batches processed (loop continued). Empty BatchRows landed
    // for each, with empty messageSnapshot (verify skipped each msg).
    const batches = await store.withTxn((txn) => txn.listBatches({ chainId: CHAIN_ID }));
    expect(batches.length).toBe(2);
    expect(batches.every((b) => b.messageSnapshot.length === 0)).toBe(true);
  });
});
