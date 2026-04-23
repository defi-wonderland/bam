import { describe, it, expect, beforeEach } from 'vitest';
import {
  bytesToHex,
  computeMessageHash,
  generateECDSAPrivateKey,
  signECDSA,
  type Address,
  type Bytes32,
} from 'bam-sdk';
import { privateKeyToAccount } from 'viem/accounts';

import {
  LocalEcdsaSigner,
  _clearSignerRegistryForTests,
  createMemoryStore,
  createPoster,
  defaultBatchPolicy,
  type BuildAndSubmit,
  type InternalPoster,
  type PosterFactoryExtras,
} from '../../src/index.js';
import { WorkerTimer } from '../../src/submission/scheduler.js';

const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const BAM_CORE = '0x9C4b230066a6808D83F5FBa0c040E0Df2Fcc7314' as Address;

async function signedEnvelope(nonce: number): Promise<Uint8Array> {
  const pk = generateECDSAPrivateKey() as `0x${string}`;
  const author = privateKeyToAccount(pk).address as Address;
  const timestamp = 1_700_000_000;
  const content = `msg-${nonce}`;
  const hash = computeMessageHash({ author, timestamp, nonce, content });
  const sig = await signECDSA(pk, bytesToHex(hash) as Bytes32);
  return new TextEncoder().encode(
    JSON.stringify({
      contentTag: TAG,
      message: { author, timestamp, nonce, content, signature: bytesToHex(sig) },
    })
  );
}

describe('WorkerTimer', () => {
  it('calls the tick callback repeatedly until stopped', async () => {
    let calls = 0;
    const timer = new WorkerTimer(async () => {
      calls++;
      return 5;
    });
    timer.start(0);
    await new Promise((r) => setTimeout(r, 50));
    await timer.stop();
    const after = calls;
    expect(after).toBeGreaterThan(2);
    // No further ticks after stop.
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(after);
  });

  it('stops permanently when the callback returns null', async () => {
    let calls = 0;
    const timer = new WorkerTimer(async () => {
      calls++;
      return calls >= 2 ? null : 5;
    });
    timer.start(0);
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toBe(2);
    await timer.stop();
  });

  it('reschedules with a conservative delay when the callback throws', async () => {
    let calls = 0;
    const timer = new WorkerTimer(async () => {
      calls++;
      throw new Error('boom');
    });
    timer.start(0);
    // After throw, next retry is 1 s — verify we only hit ~1 call in
    // 100 ms rather than tight-looping.
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toBe(1);
    await timer.stop();
  });

  it('stop() drains an in-flight tick', async () => {
    let inFlight = false;
    let finished = false;
    const timer = new WorkerTimer(async () => {
      inFlight = true;
      await new Promise((r) => setTimeout(r, 50));
      finished = true;
      inFlight = false;
      return 10;
    });
    timer.start(0);
    await new Promise((r) => setTimeout(r, 10)); // let the first tick start
    expect(inFlight).toBe(true);
    await timer.stop();
    expect(finished).toBe(true);
  });
});

describe('Poster.start() — autonomous scheduler (FU-1)', () => {
  beforeEach(() => _clearSignerRegistryForTests());

  it('submits ingested messages without any manual tick', async () => {
    const submissions: Array<{ tag: Bytes32; count: number }> = [];
    const buildAndSubmit: BuildAndSubmit = async ({ contentTag, messages }) => {
      submissions.push({ tag: contentTag, count: messages.length });
      return {
        kind: 'included',
        txHash: ('0x' + (submissions.length.toString(16).padStart(64, '0'))) as Bytes32,
        blobVersionedHash: ('0x' + '22'.repeat(32)) as Bytes32,
        blockNumber: 100,
      };
    };
    const rpc: PosterFactoryExtras['rpc'] = {
      async getChainId() {
        return 1;
      },
      async getCode() {
        return '0x6080' as `0x${string}`;
      },
      async getBalance() {
        return 10n ** 18n;
      },
      async getBlockNumber() {
        return 100n;
      },
      async getTransactionBlock() {
        return 100;
      },
    };
    const pk = generateECDSAPrivateKey() as `0x${string}`;
    const signer = new LocalEcdsaSigner(pk);
    const poster = await createPoster(
      {
        allowlistedTags: [TAG],
        chainId: 1,
        bamCoreAddress: BAM_CORE,
        signer,
        store: createMemoryStore(),
        batchPolicy: defaultBatchPolicy({ forceFlush: true }),
        idlePollMs: 20,
        reorgPollMs: 1_000_000, // disable reorg worker for this test
      },
      { buildAndSubmit, rpc }
    );

    await poster.start();
    // Ingest a message — the scheduler should pick it up within a
    // couple of idle polls and submit it.
    await poster.submit(await signedEnvelope(1));

    await new Promise((r) => setTimeout(r, 150));
    expect(submissions.length).toBeGreaterThanOrEqual(1);
    expect(submissions[0].tag).toBe(TAG);

    await poster.stop();
  });

  it('stop() cancels the scheduler — no further submissions after stop', async () => {
    let calls = 0;
    const buildAndSubmit: BuildAndSubmit = async () => {
      calls++;
      return {
        kind: 'included',
        txHash: ('0x' + calls.toString(16).padStart(64, '0')) as Bytes32,
        blobVersionedHash: ('0x' + '22'.repeat(32)) as Bytes32,
        blockNumber: 100,
      };
    };
    const rpc: PosterFactoryExtras['rpc'] = {
      async getChainId() {
        return 1;
      },
      async getCode() {
        return '0x6080' as `0x${string}`;
      },
      async getBalance() {
        return 10n ** 18n;
      },
      async getBlockNumber() {
        return 100n;
      },
      async getTransactionBlock() {
        return 100;
      },
    };
    const pk = generateECDSAPrivateKey() as `0x${string}`;
    const signer = new LocalEcdsaSigner(pk);
    const poster = await createPoster(
      {
        allowlistedTags: [TAG],
        chainId: 1,
        bamCoreAddress: BAM_CORE,
        signer,
        store: createMemoryStore(),
        batchPolicy: defaultBatchPolicy({ forceFlush: true }),
        idlePollMs: 10,
        reorgPollMs: 1_000_000,
      },
      { buildAndSubmit, rpc }
    );
    await poster.start();
    await poster.submit(await signedEnvelope(1));
    await new Promise((r) => setTimeout(r, 50));
    await poster.stop();
    const frozen = calls;
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(frozen);
  });

  it('InternalPoster hooks bypass the scheduler', async () => {
    const buildAndSubmit: BuildAndSubmit = async () => ({
      kind: 'included',
      txHash: ('0x' + '11'.repeat(32)) as Bytes32,
      blobVersionedHash: ('0x' + '22'.repeat(32)) as Bytes32,
      blockNumber: 100,
    });
    const rpc: PosterFactoryExtras['rpc'] = {
      async getChainId() {
        return 1;
      },
      async getCode() {
        return '0x6080' as `0x${string}`;
      },
      async getBalance() {
        return 10n ** 18n;
      },
      async getBlockNumber() {
        return 100n;
      },
      async getTransactionBlock() {
        return 100;
      },
    };
    const pk = generateECDSAPrivateKey() as `0x${string}`;
    const signer = new LocalEcdsaSigner(pk);
    const poster = await createPoster(
      {
        allowlistedTags: [TAG],
        chainId: 1,
        bamCoreAddress: BAM_CORE,
        signer,
        store: createMemoryStore(),
        batchPolicy: defaultBatchPolicy({ forceFlush: true }),
      },
      { buildAndSubmit, rpc }
    );
    // Don't call start(); drive manually.
    const internal = poster as InternalPoster;
    await poster.submit(await signedEnvelope(1));
    const outcome = await internal._tickTag(TAG);
    expect(outcome).toBe('success');
    expect(internal._started()).toBe(false);
    await poster.stop();
    expect(internal._stopped()).toBe(true);
  });
});
