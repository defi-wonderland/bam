import { beforeAll, describe, expect, it } from 'vitest';
import {
  BAM_CORE_ABI,
  decodeBatch,
  decodeBatchABI,
  encodeBatch,
  encodeBatchABI,
  loadTrustedSetup,
  type Address,
  type BAMMessage,
  type Bytes32,
} from 'bam-sdk';
import { decodeFunctionData, type Kzg } from 'viem';

import {
  buildAndSubmitWithViem,
  type BuildAndSubmitTransport,
} from '../src/submission/build-and-submit.js';
import { resolveProfileAddresses } from '../src/profile.js';
import type { DecodedMessage, Signer } from '../src/types.js';

beforeAll(() => {
  loadTrustedSetup();
});

const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;
const SENDER = ('0x' + '11'.repeat(20)) as Address;
const BAM_CORE = ('0x' + '22'.repeat(20)) as Address;
const ECDSA_REGISTRY = ('0xF4Ce909305a112C2CBEC6b339a42f34bA8bf3381'.toLowerCase()) as Address;
const ABI_DECODER = '0x0123456789abcdef0123456789abcdef01234567' as Address;
const ZERO = ('0x' + '00'.repeat(20)) as Address;

class StubSigner implements Signer {
  account() {
    return { address: SENDER, type: 'json-rpc' as const };
  }
}

function decoded(nonce: number): DecodedMessage {
  const contents = new Uint8Array(40);
  contents.fill(0xaa, 0, 32);
  for (let i = 32; i < 40; i++) contents[i] = (nonce + i) & 0xff;
  const sig = new Uint8Array(65);
  for (let i = 0; i < 65; i++) sig[i] = (nonce * 7 + i) & 0xff;
  return {
    sender: SENDER,
    nonce: BigInt(nonce),
    contents,
    contentTag: TAG,
    signature: sig,
    messageHash: ('0x' + nonce.toString(16).padStart(64, '0')) as Bytes32,
  };
}

const stubKzg: Kzg = {
  blobToKzgCommitment: () => new Uint8Array(48),
  computeBlobKzgProof: () => new Uint8Array(48),
};

interface CapturedSubmission {
  to: Address;
  data: `0x${string}`;
  blob: Uint8Array;
}

function makeCapturingTransport(captured: CapturedSubmission[]): BuildAndSubmitTransport {
  return {
    async sendBlobTransaction({ to, data, blobs }) {
      captured.push({ to, data, blob: blobs[0] });
      return ('0x' + '99'.repeat(32)) as `0x${string}`;
    },
    async waitForReceipt() {
      return { blockNumber: 1n, transactionIndex: 0 };
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
      return 1n;
    },
    async getTransactionReceipt() {
      return { blockNumber: 1n };
    },
  };
}

/**
 * Inverse of `createBlob`: extract the leading `length` bytes that were
 * packed into the blob. Each 32-byte FE has byte 0 reserved (0x00); the
 * usable payload sits in bytes 1-31.
 */
function unpackBlob(blob: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let dst = 0;
  for (let fe = 0; fe < blob.length / 32 && dst < length; fe++) {
    const start = fe * 32 + 1;
    const take = Math.min(31, length - dst);
    out.set(blob.slice(start, start + take), dst);
    dst += take;
  }
  return out;
}

const STUB_DEPLOYMENT = {
  chainId: 31337,
  name: 'devnet',
  contracts: {
    ECDSARegistry: { address: ECDSA_REGISTRY },
    ABIDecoder: { address: ABI_DECODER },
  },
};

const stubLookup = (chainId: number) =>
  chainId === 31337 ? STUB_DEPLOYMENT : undefined;

async function runOne(
  profile: 'default' | 'canonical-registry' | 'canonical-full'
): Promise<CapturedSubmission> {
  const captured: CapturedSubmission[] = [];
  const resolved = resolveProfileAddresses(profile, 31337, stubLookup);
  const encoder =
    profile === 'canonical-full'
      ? (msgs: BAMMessage[], sigs: Uint8Array[]) => encodeBatchABI(msgs, sigs)
      : undefined;
  const { buildAndSubmit } = await buildAndSubmitWithViem({
    rpcUrl: 'http://localhost:8545',
    chainId: 31337,
    bamCoreAddress: BAM_CORE,
    signer: new StubSigner(),
    decoderAddress: resolved.decoderAddress,
    signatureRegistryAddress: resolved.signatureRegistryAddress,
    encoder,
    transport: makeCapturingTransport(captured),
    kzgLoader: async () => stubKzg,
    logger: () => undefined,
  });
  const messages = [decoded(1), decoded(2)];
  const outcome = await buildAndSubmit({ contentTag: TAG, messages });
  expect(outcome.kind).toBe('included');
  expect(captured).toHaveLength(1);
  return captured[0];
}

function decodeArgs(data: `0x${string}`): {
  decoder: Address;
  registry: Address;
} {
  const { args } = decodeFunctionData({ abi: BAM_CORE_ABI, data });
  // registerBlobBatch(uint256, uint8, uint16, bytes32, address, address)
  return { decoder: args[4] as Address, registry: args[5] as Address };
}

describe('Poster build flow per POSTER_BATCH_PROFILE', () => {
  it('default → calldata carries (0x0, 0x0); blob payload decodes via decodeBatch', async () => {
    const cap = await runOne('default');
    const { decoder, registry } = decodeArgs(cap.data);
    expect(decoder.toLowerCase()).toBe(ZERO);
    expect(registry.toLowerCase()).toBe(ZERO);

    // Reconstruct the expected SDK binary batch and confirm the blob
    // carries it in its leading bytes.
    const messages = [decoded(1), decoded(2)];
    const expected = encodeBatch(
      messages.map((m) => ({ sender: m.sender, nonce: m.nonce, contents: m.contents })),
      messages.map((m) => m.signature)
    ).data;
    const unpacked = unpackBlob(cap.blob, expected.length);
    expect(Array.from(unpacked)).toEqual(Array.from(expected));

    // And the unpacked payload round-trips via decodeBatch.
    const round = decodeBatch(unpacked);
    expect(round.messages.length).toBe(2);
  });

  it('canonical-registry → calldata carries (0x0, ECDSARegistry); payload via decodeBatch', async () => {
    const cap = await runOne('canonical-registry');
    const { decoder, registry } = decodeArgs(cap.data);
    expect(decoder.toLowerCase()).toBe(ZERO);
    expect(registry.toLowerCase()).toBe(ECDSA_REGISTRY);

    const messages = [decoded(1), decoded(2)];
    const expected = encodeBatch(
      messages.map((m) => ({ sender: m.sender, nonce: m.nonce, contents: m.contents })),
      messages.map((m) => m.signature)
    ).data;
    const unpacked = unpackBlob(cap.blob, expected.length);
    expect(Array.from(unpacked)).toEqual(Array.from(expected));

    const round = decodeBatch(unpacked);
    expect(round.messages.length).toBe(2);
  });

  it('canonical-full → calldata carries (ABIDecoder, ECDSARegistry); payload via decodeBatchABI', async () => {
    const cap = await runOne('canonical-full');
    const { decoder, registry } = decodeArgs(cap.data);
    expect(decoder.toLowerCase()).toBe(ABI_DECODER);
    expect(registry.toLowerCase()).toBe(ECDSA_REGISTRY);

    const messages = [decoded(1), decoded(2)];
    const expected = encodeBatchABI(
      messages.map((m) => ({ sender: m.sender, nonce: m.nonce, contents: m.contents })),
      messages.map((m) => m.signature)
    );
    const unpacked = unpackBlob(cap.blob, expected.length);
    expect(Array.from(unpacked)).toEqual(Array.from(expected));

    // Confirms the payload is ABI-shaped (round-trips via the ABI codec)
    // and is *not* SDK-binary-shaped (decodeBatch would reject).
    const round = decodeBatchABI(unpacked);
    expect(round.messages.length).toBe(2);
    expect(() => decodeBatch(unpacked)).toThrow();
  });
});
