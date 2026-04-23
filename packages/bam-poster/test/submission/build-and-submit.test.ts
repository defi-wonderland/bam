import { describe, it, expect, beforeAll } from 'vitest';
import {
  bytesToHex,
  computeMessageHash,
  computeMessageId,
  generateECDSAPrivateKey,
  loadTrustedSetup,
  signECDSA,
  type Address,
  type Bytes32,
} from 'bam-sdk';
import { privateKeyToAccount } from 'viem/accounts';
import type { Kzg } from 'viem';

import {
  buildAndSubmitWithViem,
  classifySubmissionError,
  type BuildAndSubmitTransport,
} from '../../src/submission/build-and-submit.js';
import { LocalEcdsaSigner } from '../../src/signer/local.js';
import type { DecodedMessage } from '../../src/types.js';

const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const BAM_CORE = '0x9C4b230066a6808D83F5FBa0c040E0Df2Fcc7314' as Address;

// `commitToBlob` (in bam-sdk) needs the KZG trusted setup. Load once
// for all tests in this file. Safe to call repeatedly — the sdk
// short-circuits if the native setup is already loaded.
beforeAll(() => {
  loadTrustedSetup();
});

async function signedDecoded(): Promise<DecodedMessage> {
  const pk = generateECDSAPrivateKey() as `0x${string}`;
  const author = privateKeyToAccount(pk).address as Address;
  const timestamp = 1_700_000_000;
  const nonce = 1;
  const content = 'hello';
  const hash = computeMessageHash({ author, timestamp, nonce, content });
  const signature = await signECDSA(pk, bytesToHex(hash) as Bytes32);
  return {
    author,
    timestamp,
    nonce: BigInt(nonce),
    content,
    contentTag: TAG,
    signature,
    messageId: computeMessageId({ author, timestamp, nonce, content }),
    raw: new Uint8Array([0x00]),
  };
}

function makeTransport(
  overrides: Partial<BuildAndSubmitTransport> = {}
): BuildAndSubmitTransport {
  const base: BuildAndSubmitTransport = {
    async sendBlobTransaction() {
      return ('0x' + 'de'.repeat(32)) as `0x${string}`;
    },
    async waitForReceipt() {
      return { blockNumber: 42n };
    },
    async getChainId() {
      return 1;
    },
    async getBytecode() {
      return '0x6080' as `0x${string}`;
    },
    async getBalance() {
      return 10n ** 18n;
    },
    async getBlockNumber() {
      return 100n;
    },
    async getTransactionReceipt() {
      return { blockNumber: 42n };
    },
  };
  return { ...base, ...overrides };
}

const STUB_KZG: Kzg = {
  blobToKzgCommitment: () => new Uint8Array(48),
  computeBlobKzgProof: () => new Uint8Array(48),
};

async function factory(
  transport: BuildAndSubmitTransport,
  kzgLoader: () => Promise<Kzg> = async () => STUB_KZG
): Promise<ReturnType<typeof buildAndSubmitWithViem>> {
  return buildAndSubmitWithViem({
    rpcUrl: 'http://unused',
    chainId: 1,
    bamCoreAddress: BAM_CORE,
    signer: new LocalEcdsaSigner(generateECDSAPrivateKey() as `0x${string}`),
    transport,
    kzgLoader,
  });
}

describe('classifySubmissionError', () => {
  it('classifies revert-shaped errors as permanent', () => {
    expect(classifySubmissionError(new Error('execution reverted: invalid tag'))).toEqual({
      kind: 'permanent',
      detail: 'submission_failed',
    });
    expect(classifySubmissionError(new Error('Reverted with reason'))).toEqual({
      kind: 'permanent',
      detail: 'submission_failed',
    });
  });

  it('classifies /invalid/i-shaped errors as permanent', () => {
    expect(classifySubmissionError(new Error('invalid sender nonce'))).toEqual({
      kind: 'permanent',
      detail: 'submission_failed',
    });
  });

  it('classifies transient / network errors as retryable', () => {
    expect(classifySubmissionError(new Error('fetch failed'))).toEqual({
      kind: 'retryable',
      detail: 'submission_failed',
    });
    expect(classifySubmissionError(new Error('insufficient funds for gas'))).toEqual({
      kind: 'retryable',
      detail: 'submission_failed',
    });
    expect(classifySubmissionError(new Error('blob gas too low'))).toEqual({
      kind: 'retryable',
      detail: 'submission_failed',
    });
  });

  it('handles non-Error thrown values', () => {
    expect(classifySubmissionError('revert')).toEqual({
      kind: 'permanent',
      detail: 'submission_failed',
    });
    expect(classifySubmissionError(42)).toEqual({
      kind: 'retryable',
      detail: 'submission_failed',
    });
  });
});

describe('buildAndSubmitWithViem — happy path', () => {
  it('returns `included` with the txHash + block the transport reports', async () => {
    const transport = makeTransport({
      async sendBlobTransaction() {
        return ('0x' + 'ab'.repeat(32)) as `0x${string}`;
      },
      async waitForReceipt() {
        return { blockNumber: 123n };
      },
    });
    const { buildAndSubmit } = await factory(transport);
    const msg = await signedDecoded();
    const outcome = await buildAndSubmit({ contentTag: TAG, messages: [msg] });
    expect(outcome.kind).toBe('included');
    if (outcome.kind === 'included') {
      expect(outcome.txHash).toBe('0x' + 'ab'.repeat(32));
      expect(outcome.blockNumber).toBe(123);
      expect(outcome.blobVersionedHash).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });
});

describe('buildAndSubmitWithViem — error paths', () => {
  it('maps a revert error from sendBlobTransaction to permanent', async () => {
    const transport = makeTransport({
      async sendBlobTransaction() {
        throw new Error('execution reverted: out of gas');
      },
    });
    const { buildAndSubmit } = await factory(transport);
    const outcome = await buildAndSubmit({
      contentTag: TAG,
      messages: [await signedDecoded()],
    });
    expect(outcome.kind).toBe('permanent');
  });

  it('maps an RPC timeout error to retryable', async () => {
    const transport = makeTransport({
      async sendBlobTransaction() {
        throw new Error('request timeout');
      },
    });
    const { buildAndSubmit } = await factory(transport);
    const outcome = await buildAndSubmit({
      contentTag: TAG,
      messages: [await signedDecoded()],
    });
    expect(outcome.kind).toBe('retryable');
  });

  it('maps a waitForReceipt failure as retryable (receipt hasn\'t landed yet)', async () => {
    const transport = makeTransport({
      async waitForReceipt() {
        throw new Error('network unreachable');
      },
    });
    const { buildAndSubmit } = await factory(transport);
    const outcome = await buildAndSubmit({
      contentTag: TAG,
      messages: [await signedDecoded()],
    });
    expect(outcome.kind).toBe('retryable');
  });
});

describe('buildAndSubmitWithViem — lazy KZG load', () => {
  it('does not invoke kzgLoader at factory construction time', async () => {
    let loads = 0;
    const loader = async (): Promise<Kzg> => {
      loads++;
      return STUB_KZG;
    };
    await factory(makeTransport(), loader);
    // Construction must not trigger KZG load — CLI startup stays fast.
    expect(loads).toBe(0);
  });

  it('invokes kzgLoader on first submission', async () => {
    let loads = 0;
    const loader = async (): Promise<Kzg> => {
      loads++;
      return STUB_KZG;
    };
    const { buildAndSubmit } = await factory(makeTransport(), loader);
    const msg = await signedDecoded();
    await buildAndSubmit({ contentTag: TAG, messages: [msg] });
    expect(loads).toBeGreaterThanOrEqual(1);
  });

  it('default kzgLoader (no override) resolves c-kzg without ReferenceError — ESM createRequire path (R1)', async () => {
    // No `kzgLoader` override — exercises the `createRequire('c-kzg')`
    // default path. Under plain ESM, a bare `require('c-kzg')` throws
    // `ReferenceError: require is not defined` which would have been
    // caught by the error classifier + returned `retryable`. This test
    // asserts the submission actually lands.
    const { buildAndSubmit } = await buildAndSubmitWithViem({
      rpcUrl: 'http://unused',
      chainId: 1,
      bamCoreAddress: BAM_CORE,
      signer: new LocalEcdsaSigner(generateECDSAPrivateKey() as `0x${string}`),
      transport: makeTransport(),
      // No kzgLoader — default path runs.
    });
    const msg = await signedDecoded();
    const outcome = await buildAndSubmit({ contentTag: TAG, messages: [msg] });
    expect(outcome.kind).toBe('included');
  });
});

describe('buildAndSubmitWithViem — rpc surface', () => {
  it('proxies chain-id / bytecode / balance / block / tx receipt through transport', async () => {
    const transport = makeTransport({
      async getChainId() {
        return 11155111;
      },
      async getBytecode() {
        return '0xdead' as `0x${string}`;
      },
      async getBalance() {
        return 777n;
      },
      async getBlockNumber() {
        return 55n;
      },
      async getTransactionReceipt() {
        return { blockNumber: 40n };
      },
    });
    const { rpc } = await factory(transport);
    expect(await rpc.getChainId()).toBe(11155111);
    expect(await rpc.getCode(BAM_CORE)).toBe('0xdead');
    expect(await rpc.getBalance(BAM_CORE)).toBe(777n);
    expect(await rpc.getBlockNumber()).toBe(55n);
    expect(await rpc.getTransactionBlock(('0x' + '11'.repeat(32)) as Bytes32)).toBe(40);
  });

  it('getTransactionBlock returns null when the transport says null', async () => {
    const transport = makeTransport({
      async getTransactionReceipt() {
        return null;
      },
    });
    const { rpc } = await factory(transport);
    expect(await rpc.getTransactionBlock(('0x' + '22'.repeat(32)) as Bytes32)).toBeNull();
  });
});
