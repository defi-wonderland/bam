import { beforeAll, describe, expect, it } from 'vitest';
import { decodeFunctionData, zeroAddress } from 'viem';
import {
  BAM_CORE_ABI,
  decodeBatch,
  decodeBatchABI,
  loadTrustedSetup,
  type Address,
  type Bytes32,
} from 'bam-sdk';

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
      batchEncoding: 'binary',
      decoderAddress: zeroAddress,
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
      batchEncoding: 'binary',
      decoderAddress: zeroAddress,
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
      batchEncoding: 'binary',
      decoderAddress: zeroAddress,
      transport,
      kzgLoader: async () => stubKzg,
      logger: () => undefined,
    });
    const outcome = await buildAndSubmit({ contentTag: TAG, messages: [decoded(1)] });
    expect(outcome.kind).toBe('retryable');
  });

  // ── Encoder selection (feature 009) ───────────────────────────────────
  // Pull the original encoded batch bytes back out of the EIP-4844 blob
  // the transport saw. `createBlob` packs bytes 1..31 of each FE; byte 0
  // of every FE is left at 0x00. Concatenate the byte-1..31 windows and
  // truncate to the expected length.
  function unpackBlob(blob: Uint8Array, payloadLen: number): Uint8Array {
    const out = new Uint8Array(payloadLen);
    let written = 0;
    for (let fe = 0; fe < 4096 && written < payloadLen; fe++) {
      const feOffset = fe * 32;
      const take = Math.min(31, payloadLen - written);
      out.set(blob.subarray(feOffset + 1, feOffset + 1 + take), written);
      written += take;
    }
    return out;
  }

  function decodeRegisterBlobBatch(data: `0x${string}`) {
    return decodeFunctionData({ abi: BAM_CORE_ABI, data });
  }

  describe('encoder selection by batchEncoding', () => {
    const RESOLVED_DECODER = ('0x' + 'cd'.repeat(20)) as Address;

    async function captureSubmission(
      batchEncoding: 'binary' | 'abi',
      decoderAddress: Address
    ): Promise<{ blob: Uint8Array; data: `0x${string}` }> {
      let captured: { blob: Uint8Array; data: `0x${string}` } | undefined;
      const transport = mkTransport({
        async sendBlobTransaction(args) {
          captured = {
            blob: new Uint8Array(args.blobs[0]),
            data: args.data,
          };
          return ('0x' + 'ab'.repeat(32)) as `0x${string}`;
        },
      });
      const { buildAndSubmit } = await buildAndSubmitWithViem({
        rpcUrl: 'http://localhost:8545',
        chainId: 31337,
        bamCoreAddress: BAM_CORE,
        signer: new StubSigner(),
        batchEncoding,
        decoderAddress,
        transport,
        kzgLoader: async () => stubKzg,
      });
      const out = await buildAndSubmit({ contentTag: TAG, messages: [decoded(1)] });
      expect(out.kind).toBe('included');
      if (!captured) throw new Error('transport never received a submission');
      return captured;
    }

    it('binary: encodeBatch is used (blob starts with 0x02 BATCH_VERSION) and decoder arg is zeroAddress', async () => {
      const { blob, data } = await captureSubmission('binary', zeroAddress);
      // Binary header: byte 0 = 0x02 (BATCH_VERSION).
      expect(blob[1]).toBe(0x02);
      // Round-trip through decodeBatch to confirm the binary codec ran.
      const unpacked = unpackBlob(blob, /* large enough for 1 small message */ 256);
      const headerOk = unpacked[0] === 0x02 && unpacked[1] === 0x00;
      expect(headerOk).toBe(true);
      const decodedBatch = decodeBatch(unpacked.subarray(0, 10 + ((unpacked[6] << 24) | (unpacked[7] << 16) | (unpacked[8] << 8) | unpacked[9])));
      expect(decodedBatch.messages.length).toBe(1);

      const fn = decodeRegisterBlobBatch(data);
      expect(fn.functionName).toBe('registerBlobBatch');
      const args = fn.args as readonly [bigint, number, number, Bytes32, Address, Address];
      const [, , , , decoderArg, sigRegistryArg] = args;
      expect(decoderArg.toLowerCase()).toBe(zeroAddress);
      expect(sigRegistryArg.toLowerCase()).toBe(zeroAddress);
    });

    it('abi: encodeBatchABI is used (blob decodes via decodeBatchABI) and decoder arg is the resolved address', async () => {
      const { blob, data } = await captureSubmission('abi', RESOLVED_DECODER);
      // ABI envelope's first word is the offset to the messages array
      // (0x40), which is big-endian → bytes 0..30 are 0x00, byte 31 = 0x40.
      // In the blob, FE byte 0 is reserved (0x00), so original byte 0
      // lands at blob[1] = 0x00.
      expect(blob[1]).toBe(0x00);
      // Read enough bytes to cover the ABI envelope (1 message: ~448 bytes).
      const unpacked = unpackBlob(blob, 1024);
      // Find the actual encoded length by trimming trailing zeros only
      // *after* the ABI envelope decodes. Easier: try decoding a few
      // candidate lengths until one succeeds.
      let decodedAbi: ReturnType<typeof decodeBatchABI> | null = null;
      for (let len = 32; len <= unpacked.length; len += 32) {
        try {
          decodedAbi = decodeBatchABI(unpacked.subarray(0, len));
          if (decodedAbi.messages.length === 1) break;
          decodedAbi = null;
        } catch {
          // wrong length — keep scanning
        }
      }
      expect(decodedAbi).not.toBeNull();
      expect(decodedAbi!.messages.length).toBe(1);

      const fn = decodeRegisterBlobBatch(data);
      expect(fn.functionName).toBe('registerBlobBatch');
      const args = fn.args as readonly [bigint, number, number, Bytes32, Address, Address];
      const [, , , , decoderArg, sigRegistryArg] = args;
      expect(decoderArg.toLowerCase()).toBe(RESOLVED_DECODER.toLowerCase());
      expect(sigRegistryArg.toLowerCase()).toBe(zeroAddress);
    });

    it('signatureRegistryAddress option still threads when explicitly provided', async () => {
      // Confirms that an explicit caller value still wins — the feature
      // doesn't remove `signatureRegistryAddress` from the option shape.
      const sigReg = ('0x' + 'ee'.repeat(20)) as Address;
      let captured: `0x${string}` | undefined;
      const transport = mkTransport({
        async sendBlobTransaction(args) {
          captured = args.data;
          return ('0x' + 'ab'.repeat(32)) as `0x${string}`;
        },
      });
      const { buildAndSubmit } = await buildAndSubmitWithViem({
        rpcUrl: 'http://localhost:8545',
        chainId: 31337,
        bamCoreAddress: BAM_CORE,
        signer: new StubSigner(),
        batchEncoding: 'binary',
        decoderAddress: zeroAddress,
        signatureRegistryAddress: sigReg,
        transport,
        kzgLoader: async () => stubKzg,
      });
      await buildAndSubmit({ contentTag: TAG, messages: [decoded(1)] });
      const fn = decodeRegisterBlobBatch(captured!);
      const [, , , , , sigRegArg] = fn.args as readonly [
        bigint,
        number,
        number,
        Bytes32,
        Address,
        Address,
      ];
      expect(sigRegArg.toLowerCase()).toBe(sigReg.toLowerCase());
    });

    it('TypeScript: decoderAddress is mandatory on BuildAndSubmitOptions', async () => {
      // @ts-expect-error decoderAddress is mandatory; omitting it must error.
      await buildAndSubmitWithViem({
        rpcUrl: 'http://localhost:8545',
        chainId: 31337,
        bamCoreAddress: BAM_CORE,
        signer: new StubSigner(),
        batchEncoding: 'binary',
        transport: mkTransport(),
        kzgLoader: async () => stubKzg,
      }).catch(() => {
        // The runtime-shape branch executes downstream; the only thing
        // this assertion guards is the type annotation above.
      });
    });
  });

  it('rpc exposes getChainId + getBalance + getTransactionBlock', async () => {
    const { rpc } = await buildAndSubmitWithViem({
      rpcUrl: 'http://localhost:8545',
      chainId: 31337,
      bamCoreAddress: BAM_CORE,
      signer: new StubSigner(),
      batchEncoding: 'binary',
      decoderAddress: zeroAddress,
      transport: mkTransport(),
      kzgLoader: async () => stubKzg,
    });
    expect(await rpc.getChainId()).toBe(31337);
    expect(await rpc.getBalance(SENDER)).toBe(10n ** 18n);
    expect(await rpc.getTransactionBlock(('0x' + '01'.repeat(32)) as Bytes32)).toBe(1234);
  });
});
