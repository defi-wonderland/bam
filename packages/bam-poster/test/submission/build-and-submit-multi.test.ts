import { beforeAll, describe, expect, it } from 'vitest';
import {
  computeMessageHashForMessage,
  deriveAddress,
  encodeBatch,
  encodeContents,
  generateECDSAPrivateKey,
  hexToBytes,
  loadTrustedSetup,
  signECDSAWithKey,
  type Address,
  type BAMMessage,
  type Bytes32,
} from 'bam-sdk';
import { BAM_CORE_ABI } from 'bam-sdk';
import { decodeFunctionData, type Kzg } from 'viem';

import {
  buildAndSubmitWithViem,
  classifySubmissionError,
  type BuildAndSubmitTransport,
} from '../../src/submission/build-and-submit.js';
import type { PackResult } from '../../src/submission/aggregator.js';
import type { DecodedMessage, Signer } from '../../src/types.js';

beforeAll(() => {
  loadTrustedSetup();
});

const TAG_A = ('0x' + 'a1'.repeat(32)) as Bytes32;
const TAG_B = ('0x' + 'b2'.repeat(32)) as Bytes32;
const BAM_CORE = ('0x' + '22'.repeat(20)) as Address;
const CHAIN_ID = 31337;

class StubSigner implements Signer {
  account() {
    return {
      address: ('0x' + '11'.repeat(20)) as Address,
      type: 'json-rpc' as const,
    };
  }
}

function mkTransport(
  overrides: Partial<BuildAndSubmitTransport> = {}
): BuildAndSubmitTransport {
  return {
    async sendBlobTransaction() {
      return ('0x' + '99'.repeat(32)) as `0x${string}`;
    },
    async waitForReceipt() {
      return { blockNumber: 1234n, transactionIndex: 0 };
    },
    async getChainId() {
      return CHAIN_ID;
    },
    async getBytecode() {
      return '0x6060604052' as `0x${string}`;
    },
    async getBalance() {
      return 10n ** 18n;
    },
    async getBlockNumber() {
      return 1234n;
    },
    async getTransactionReceipt() {
      return { blockNumber: 1234n };
    },
    ...overrides,
  };
}

const stubKzg: Kzg = {
  blobToKzgCommitment: () => new Uint8Array(48),
  computeBlobKzgProof: () => new Uint8Array(48),
};

function signed(
  nonce: bigint,
  payload: Uint8Array,
  tag: Bytes32
): { decoded: DecodedMessage; bam: BAMMessage; signature: Uint8Array } {
  const priv = generateECDSAPrivateKey();
  const sender = deriveAddress(priv);
  const contents = encodeContents(tag, payload);
  const bam: BAMMessage = { sender, nonce, contents };
  const sigHex = signECDSAWithKey(priv, bam, CHAIN_ID);
  const signature = hexToBytes(sigHex);
  return {
    bam,
    signature,
    decoded: {
      sender,
      nonce,
      contents,
      contentTag: tag,
      signature,
      messageHash: computeMessageHashForMessage(bam),
      ingestedAt: Number(nonce) * 1_000,
    },
  };
}

function buildPack(
  msgsA: { bam: BAMMessage; signature: Uint8Array; decoded: DecodedMessage }[],
  msgsB: { bam: BAMMessage; signature: Uint8Array; decoded: DecodedMessage }[]
): PackResult {
  const encA = encodeBatch(msgsA.map((m) => m.bam), msgsA.map((m) => m.signature));
  const encB = encodeBatch(msgsB.map((m) => m.bam), msgsB.map((m) => m.signature));

  const aFEs = Math.ceil(encA.data.length / 31);
  const bFEs = Math.ceil(encB.data.length / 31);

  const includedSelections = new Map<
    Bytes32,
    {
      contentTag: Bytes32;
      messages: DecodedMessage[];
      payloadBytes: Uint8Array;
    }
  >();
  includedSelections.set(TAG_A, {
    contentTag: TAG_A,
    messages: msgsA.map((m) => m.decoded),
    payloadBytes: encA.data,
  });
  includedSelections.set(TAG_B, {
    contentTag: TAG_B,
    messages: msgsB.map((m) => m.decoded),
    payloadBytes: encB.data,
  });

  return {
    plan: {
      included: [
        {
          contentTag: TAG_A,
          startFE: 0,
          endFE: aFEs,
          payloadBytes: encA.data,
        },
        {
          contentTag: TAG_B,
          startFE: aFEs,
          endFE: aFEs + bFEs,
          payloadBytes: encB.data,
        },
      ],
      excluded: [],
    },
    includedSelections,
    excludedTags: [],
  };
}

describe('buildAndSubmitMulti', () => {
  it('encodes calldata to registerBlobBatches with one element per included tag', async () => {
    const a1 = signed(1n, new Uint8Array([1, 2, 3]), TAG_A);
    const b1 = signed(1n, new Uint8Array([4, 5, 6]), TAG_B);
    const pack = buildPack([a1], [b1]);

    let observedData: `0x${string}` | null = null;
    let observedBlobCount: number | null = null;
    const transport = mkTransport({
      async sendBlobTransaction({ data, blobs }) {
        observedData = data;
        observedBlobCount = blobs.length;
        return ('0x' + 'ab'.repeat(32)) as `0x${string}`;
      },
      async waitForReceipt() {
        return { blockNumber: 100n, transactionIndex: 5 };
      },
    });

    const { buildAndSubmitMulti } = await buildAndSubmitWithViem({
      rpcUrl: 'http://localhost:8545',
      chainId: CHAIN_ID,
      bamCoreAddress: BAM_CORE,
      signer: new StubSigner(),
      transport,
      kzgLoader: async () => stubKzg,
      logger: () => undefined,
    });

    const outcome = await buildAndSubmitMulti({ pack });
    expect(outcome.kind).toBe('included');
    if (outcome.kind !== 'included') return;

    expect(observedBlobCount).toBe(1);
    expect(outcome.txHash).toBe('0x' + 'ab'.repeat(32));
    expect(outcome.blockNumber).toBe(100);
    expect(outcome.txIndex).toBe(5);
    expect(outcome.entries).toHaveLength(2);
    expect(outcome.entries.map((e) => e.contentTag)).toEqual([TAG_A, TAG_B]);

    // Decode the calldata: must target `registerBlobBatches` with a
    // 2-element array.
    const decoded = decodeFunctionData({
      abi: BAM_CORE_ABI,
      data: observedData!,
    });
    expect(decoded.functionName).toBe('registerBlobBatches');
    const calls = decoded.args![0] as readonly {
      blobIndex: bigint;
      startFE: number;
      endFE: number;
      contentTag: Bytes32;
    }[];
    expect(calls).toHaveLength(2);
    expect(calls[0]!.contentTag).toBe(TAG_A);
    expect(calls[1]!.contentTag).toBe(TAG_B);
    expect(calls[0]!.startFE).toBe(0);
    expect(calls[1]!.startFE).toBe(calls[0]!.endFE);
  });

  it('single-entry pack produces a one-element registerBlobBatches call', async () => {
    const a1 = signed(1n, new Uint8Array([1, 2, 3]), TAG_A);
    const enc = encodeBatch([a1.bam], [a1.signature]);
    const aFEs = Math.ceil(enc.data.length / 31);
    const includedSelections = new Map([
      [
        TAG_A,
        {
          contentTag: TAG_A,
          messages: [a1.decoded],
          payloadBytes: enc.data,
        },
      ],
    ]);
    const pack: PackResult = {
      plan: {
        included: [
          { contentTag: TAG_A, startFE: 0, endFE: aFEs, payloadBytes: enc.data },
        ],
        excluded: [],
      },
      includedSelections,
      excludedTags: [],
    };

    let observedData: `0x${string}` | null = null;
    const transport = mkTransport({
      async sendBlobTransaction({ data }) {
        observedData = data;
        return ('0x' + 'cc'.repeat(32)) as `0x${string}`;
      },
    });

    const { buildAndSubmitMulti } = await buildAndSubmitWithViem({
      rpcUrl: 'http://localhost:8545',
      chainId: CHAIN_ID,
      bamCoreAddress: BAM_CORE,
      signer: new StubSigner(),
      transport,
      kzgLoader: async () => stubKzg,
      logger: () => undefined,
    });

    const outcome = await buildAndSubmitMulti({ pack });
    expect(outcome.kind).toBe('included');
    const decoded = decodeFunctionData({
      abi: BAM_CORE_ABI,
      data: observedData!,
    });
    expect(decoded.functionName).toBe('registerBlobBatches');
    const calls = decoded.args![0] as readonly unknown[];
    expect(calls).toHaveLength(1);
  });

  it('empty pack returns permanent (defense in depth — should never be invoked)', async () => {
    const { buildAndSubmitMulti } = await buildAndSubmitWithViem({
      rpcUrl: 'http://localhost:8545',
      chainId: CHAIN_ID,
      bamCoreAddress: BAM_CORE,
      signer: new StubSigner(),
      transport: mkTransport(),
      kzgLoader: async () => stubKzg,
      logger: () => undefined,
    });
    const outcome = await buildAndSubmitMulti({
      pack: {
        plan: { included: [], excluded: [] },
        includedSelections: new Map(),
        excludedTags: [],
      },
    });
    expect(outcome.kind).toBe('permanent');
  });

  it('self-check failure (tampered plan) → permanent, no broadcast', async () => {
    const a1 = signed(1n, new Uint8Array([1, 2, 3]), TAG_A);
    const b1 = signed(1n, new Uint8Array([4, 5, 6]), TAG_B);
    const pack = buildPack([a1], [b1]);

    // Tamper: shift TAG_A's range forward by one FE so the plan no
    // longer agrees with what the SDK would assemble.
    pack.plan.included[0]!.startFE = 1;
    pack.plan.included[0]!.endFE = pack.plan.included[0]!.endFE + 1;

    let broadcasted = false;
    const transport = mkTransport({
      async sendBlobTransaction() {
        broadcasted = true;
        return ('0x' + 'ee'.repeat(32)) as `0x${string}`;
      },
    });
    const { buildAndSubmitMulti } = await buildAndSubmitWithViem({
      rpcUrl: 'http://localhost:8545',
      chainId: CHAIN_ID,
      bamCoreAddress: BAM_CORE,
      signer: new StubSigner(),
      transport,
      kzgLoader: async () => stubKzg,
      logger: () => undefined,
    });
    const outcome = await buildAndSubmitMulti({ pack });
    expect(outcome.kind).toBe('permanent');
    expect(broadcasted).toBe(false);
  });

  it('transport "execution reverted" → permanent', async () => {
    const a1 = signed(1n, new Uint8Array([1, 2, 3]), TAG_A);
    const b1 = signed(1n, new Uint8Array([4, 5, 6]), TAG_B);
    const pack = buildPack([a1], [b1]);

    const transport = mkTransport({
      async sendBlobTransaction() {
        throw new Error('execution reverted');
      },
    });
    const { buildAndSubmitMulti } = await buildAndSubmitWithViem({
      rpcUrl: 'http://localhost:8545',
      chainId: CHAIN_ID,
      bamCoreAddress: BAM_CORE,
      signer: new StubSigner(),
      transport,
      kzgLoader: async () => stubKzg,
      logger: () => undefined,
    });
    const outcome = await buildAndSubmitMulti({ pack });
    expect(outcome.kind).toBe('permanent');
  });
});

describe('classifySubmissionError', () => {
  it('"execution reverted" → permanent', () => {
    expect(classifySubmissionError(new Error('execution reverted: foo')).kind).toBe(
      'permanent'
    );
  });

  it('"invalid opcode" → permanent', () => {
    expect(classifySubmissionError(new Error('invalid opcode')).kind).toBe('permanent');
  });

  it('"abi" match → permanent', () => {
    expect(classifySubmissionError(new Error('bad abi encoding')).kind).toBe('permanent');
  });

  it('generic network error → retryable', () => {
    expect(classifySubmissionError(new Error('ECONNRESET')).kind).toBe('retryable');
  });

  it('"invalid nonce" (transient) → retryable, NOT permanent', () => {
    expect(
      classifySubmissionError(new Error('invalid nonce — too low')).kind
    ).toBe('retryable');
  });

  it('non-Error input → retryable by default', () => {
    expect(classifySubmissionError('random string').kind).toBe('retryable');
  });
});
