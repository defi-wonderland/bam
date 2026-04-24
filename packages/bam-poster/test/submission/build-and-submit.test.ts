import { beforeAll, describe, expect, it } from 'vitest';
import { loadTrustedSetup, type Address, type Bytes32 } from 'bam-sdk';

import {
  buildAndSubmitWithViem,
  classifySubmissionError,
  type BuildAndSubmitTransport,
} from '../../src/submission/build-and-submit.js';
import type { DecodedMessage, Signer } from '../../src/types.js';
import type { Kzg } from 'viem';

// Real KZG setup is required for the in-SDK commitToBlob path; the
// viem-level `kzg` object the transport receives is separately
// stubbed below.
beforeAll(() => {
  loadTrustedSetup();
});

const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const SENDER = ('0x' + '11'.repeat(20)) as Address;
const BAM_CORE = ('0x' + '22'.repeat(20)) as Address;

function decoded(nonce: number): DecodedMessage {
  const contents = new Uint8Array(40);
  contents.fill(0xaa, 0, 32);
  return {
    sender: SENDER,
    nonce: BigInt(nonce),
    contents,
    contentTag: TAG,
    signature: new Uint8Array(65),
    messageHash: ('0x' + nonce.toString(16).padStart(64, '0')) as Bytes32,
  };
}

class StubSigner implements Signer {
  account() {
    return { address: SENDER, type: 'json-rpc' as const };
  }
}

function mkTransport(overrides: Partial<BuildAndSubmitTransport> = {}): BuildAndSubmitTransport {
  return {
    async sendBlobTransaction() {
      return ('0x' + '99'.repeat(32)) as `0x${string}`;
    },
    async waitForReceipt() {
      return { blockNumber: 1234n, transactionIndex: 0 };
    },
    async getChainId() {
      return 31337;
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
    async getTransactionReceipt(_hash: Bytes32) {
      return { blockNumber: 1234n };
    },
    ...overrides,
  };
}

const stubKzg: Kzg = {
  blobToKzgCommitment: () => new Uint8Array(48),
  computeBlobKzgProof: () => new Uint8Array(48),
};

describe('classifySubmissionError', () => {
  it('"execution reverted" → permanent', () => {
    expect(classifySubmissionError(new Error('execution reverted: foo'))).toEqual({
      kind: 'permanent',
      detail: 'submission_failed',
    });
  });

  it('"invalid opcode" → permanent', () => {
    expect(classifySubmissionError(new Error('invalid opcode')).kind).toBe('permanent');
  });

  it('"invalid signature" → permanent (ABI malformed)', () => {
    expect(classifySubmissionError(new Error('invalid signature')).kind).toBe('permanent');
  });

  it('"abi" match → permanent', () => {
    expect(classifySubmissionError(new Error('bad abi encoding')).kind).toBe('permanent');
  });

  it('generic network error → retryable', () => {
    expect(classifySubmissionError(new Error('ECONNRESET')).kind).toBe('retryable');
  });

  it('"invalid nonce" (common transient) → retryable, NOT permanent', () => {
    expect(classifySubmissionError(new Error('invalid nonce — too low')).kind).toBe(
      'retryable'
    );
  });

  it('non-Error input → retryable by default', () => {
    expect(classifySubmissionError('random string').kind).toBe('retryable');
  });
});

describe('buildAndSubmitWithViem (transport injection)', () => {
  it('included outcome contains the transport-returned tx hash + block', async () => {
    const transport = mkTransport({
      async sendBlobTransaction() {
        return ('0x' + 'ab'.repeat(32)) as `0x${string}`;
      },
      async waitForReceipt() {
        return { blockNumber: 42n, transactionIndex: 7 };
      },
    });
    const { buildAndSubmit } = await buildAndSubmitWithViem({
      rpcUrl: 'http://localhost:8545',
      chainId: 31337,
      bamCoreAddress: BAM_CORE,
      signer: new StubSigner(),
      transport,
      kzgLoader: async () => stubKzg,
    });
    const outcome = await buildAndSubmit({ contentTag: TAG, messages: [decoded(1)] });
    expect(outcome.kind).toBe('included');
    if (outcome.kind === 'included') {
      expect(outcome.txHash).toBe('0x' + 'ab'.repeat(32));
      expect(outcome.blockNumber).toBe(42);
      expect(outcome.txIndex).toBe(7);
    }
  });

  it('transport throw "execution reverted" bubbles up as permanent', async () => {
    const transport = mkTransport({
      async sendBlobTransaction() {
        throw new Error('execution reverted');
      },
    });
    const { buildAndSubmit } = await buildAndSubmitWithViem({
      rpcUrl: 'http://localhost:8545',
      chainId: 31337,
      bamCoreAddress: BAM_CORE,
      signer: new StubSigner(),
      transport,
      kzgLoader: async () => stubKzg,
      logger: () => undefined,
    });
    const outcome = await buildAndSubmit({ contentTag: TAG, messages: [decoded(1)] });
    expect(outcome.kind).toBe('permanent');
  });

  it('transport throw generic network error → retryable', async () => {
    const transport = mkTransport({
      async sendBlobTransaction() {
        throw new Error('connection refused');
      },
    });
    const { buildAndSubmit } = await buildAndSubmitWithViem({
      rpcUrl: 'http://localhost:8545',
      chainId: 31337,
      bamCoreAddress: BAM_CORE,
      signer: new StubSigner(),
      transport,
      kzgLoader: async () => stubKzg,
      logger: () => undefined,
    });
    const outcome = await buildAndSubmit({ contentTag: TAG, messages: [decoded(1)] });
    expect(outcome.kind).toBe('retryable');
  });

  it('rpc exposes getChainId + getBalance + getTransactionBlock', async () => {
    const { rpc } = await buildAndSubmitWithViem({
      rpcUrl: 'http://localhost:8545',
      chainId: 31337,
      bamCoreAddress: BAM_CORE,
      signer: new StubSigner(),
      transport: mkTransport(),
      kzgLoader: async () => stubKzg,
    });
    expect(await rpc.getChainId()).toBe(31337);
    expect(await rpc.getBalance(SENDER)).toBe(10n ** 18n);
    expect(await rpc.getTransactionBlock(('0x' + '01'.repeat(32)) as Bytes32)).toBe(1234);
  });
});
