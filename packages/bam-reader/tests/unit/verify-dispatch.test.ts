import {
  deriveAddress,
  generateECDSAPrivateKey,
  hexToBytes,
  signECDSAWithKey,
} from 'bam-sdk';
import type { Address, BAMMessage, Bytes32 } from 'bam-sdk';
import { describe, expect, it } from 'vitest';

import { verifyMessage } from '../../src/verify/dispatch.js';
import type {
  OnChainVerifyEvent,
  VerifyReadContractClient,
} from '../../src/verify/on-chain-registry.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const NON_ZERO_REGISTRY = '0x000000000000000000000000000000000000beef' as Address;
const CHAIN_ID = 11155111;
const TAG = ('0x' + 'aa'.repeat(32)) as Bytes32;

function buildSignedMessage(): { message: BAMMessage; signature: Uint8Array; sender: Address } {
  const priv = generateECDSAPrivateKey();
  const sender = deriveAddress(priv);
  const contents = new Uint8Array([0xab, 0xcd]);
  const message: BAMMessage = { sender, nonce: 7n, contents };
  const sigHex = signECDSAWithKey(priv, message, TAG, CHAIN_ID);
  return { message, signature: hexToBytes(sigHex), sender };
}

function fakePublicClient(
  handler: VerifyReadContractClient['readContract']
): VerifyReadContractClient {
  return { readContract: handler };
}

describe('verifyMessage — zero-address (SDK)', () => {
  it('returns true for a valid SDK-signed message', async () => {
    const { message, signature } = buildSignedMessage();
    const ok = await verifyMessage({
      registryAddress: ZERO_ADDRESS,
      message,
      contentTag: TAG,
      signatureBytes: signature,
      chainId: CHAIN_ID,
      gasCap: 50_000_000n,
      timeoutMs: 5_000,
    });
    expect(ok).toBe(true);
  });

  it('returns false when the signature has been tampered with', async () => {
    const { message, signature } = buildSignedMessage();
    const tampered = new Uint8Array(signature);
    tampered[0] = tampered[0] ^ 0xff;
    const ok = await verifyMessage({
      registryAddress: ZERO_ADDRESS,
      message,
      contentTag: TAG,
      signatureBytes: tampered,
      chainId: CHAIN_ID,
      gasCap: 50_000_000n,
      timeoutMs: 5_000,
    });
    expect(ok).toBe(false);
  });

  it('returns false when the contentTag differs from what was signed', async () => {
    const { message, signature } = buildSignedMessage();
    const otherTag = ('0x' + 'bb'.repeat(32)) as Bytes32;
    const ok = await verifyMessage({
      registryAddress: ZERO_ADDRESS,
      message,
      contentTag: otherTag,
      signatureBytes: signature,
      chainId: CHAIN_ID,
      gasCap: 50_000_000n,
      timeoutMs: 5_000,
    });
    expect(ok).toBe(false);
  });
});

describe('verifyMessage — non-zero (on-chain)', () => {
  it('returns whatever the registry reports on a successful eth_call', async () => {
    const { message, signature } = buildSignedMessage();
    const client = fakePublicClient(async () => true);
    const ok = await verifyMessage({
      registryAddress: NON_ZERO_REGISTRY,
      message,
      contentTag: TAG,
      signatureBytes: signature,
      chainId: CHAIN_ID,
      publicClient: client,
      gasCap: 50_000_000n,
      timeoutMs: 5_000,
    });
    expect(ok).toBe(true);
  });

  it('returns false when the registry reports false', async () => {
    const { message, signature } = buildSignedMessage();
    const client = fakePublicClient(async () => false);
    const ok = await verifyMessage({
      registryAddress: NON_ZERO_REGISTRY,
      message,
      contentTag: TAG,
      signatureBytes: signature,
      chainId: CHAIN_ID,
      publicClient: client,
      gasCap: 50_000_000n,
      timeoutMs: 5_000,
    });
    expect(ok).toBe(false);
  });

  it('returns false on revert and emits a verify_skipped log', async () => {
    const { message, signature } = buildSignedMessage();
    const events: OnChainVerifyEvent[] = [];
    const client = fakePublicClient(async () => {
      throw new Error('execution reverted: VerificationFailed');
    });
    const ok = await verifyMessage({
      registryAddress: NON_ZERO_REGISTRY,
      message,
      contentTag: TAG,
      signatureBytes: signature,
      chainId: CHAIN_ID,
      publicClient: client,
      gasCap: 50_000_000n,
      timeoutMs: 5_000,
      logger: (e) => events.push(e),
    });
    expect(ok).toBe(false);
    expect(events.length).toBe(1);
    expect(events[0].cause).toBe('revert');
  });

  it('returns false on timeout and emits a verify_skipped log', async () => {
    const { message, signature } = buildSignedMessage();
    const events: OnChainVerifyEvent[] = [];
    const client = fakePublicClient(() => new Promise(() => {}));
    const ok = await verifyMessage({
      registryAddress: NON_ZERO_REGISTRY,
      message,
      contentTag: TAG,
      signatureBytes: signature,
      chainId: CHAIN_ID,
      publicClient: client,
      gasCap: 50_000_000n,
      timeoutMs: 25,
      logger: (e) => events.push(e),
    });
    expect(ok).toBe(false);
    expect(events[0].cause).toBe('timeout');
  });

  it('returns false on a gas-cap-exceeded error and tags the cause', async () => {
    const { message, signature } = buildSignedMessage();
    const events: OnChainVerifyEvent[] = [];
    const client = fakePublicClient(async () => {
      throw new Error('intrinsic gas exceeds gas allowance');
    });
    const ok = await verifyMessage({
      registryAddress: NON_ZERO_REGISTRY,
      message,
      contentTag: TAG,
      signatureBytes: signature,
      chainId: CHAIN_ID,
      publicClient: client,
      gasCap: 21_000n,
      timeoutMs: 5_000,
      logger: (e) => events.push(e),
    });
    expect(ok).toBe(false);
    expect(events[0].cause).toBe('gas_cap');
  });

  it('returns false when no publicClient is supplied', async () => {
    const { message, signature } = buildSignedMessage();
    const events: OnChainVerifyEvent[] = [];
    const ok = await verifyMessage({
      registryAddress: NON_ZERO_REGISTRY,
      message,
      contentTag: TAG,
      signatureBytes: signature,
      chainId: CHAIN_ID,
      gasCap: 50_000_000n,
      timeoutMs: 5_000,
      logger: (e) => events.push(e),
    });
    expect(ok).toBe(false);
    expect(events.length).toBe(1);
  });
});
