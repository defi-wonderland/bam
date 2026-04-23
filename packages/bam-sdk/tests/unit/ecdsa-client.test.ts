/**
 * ECDSA registry client-wrapper tests.
 *
 * These tests run against a stubbed viem transport — no anvil, no live chain.
 * The point is to assert that `BAMClient`'s ECDSA methods produce the exact
 * calldata that `ECDSARegistry`'s ABI expects, and route `eth_call` /
 * `eth_sendTransaction` / `eth_getTransactionReceipt` correctly. Anvil-
 * backed differential verification lives in the T013 integration suite.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionData,
  encodeEventTopics,
  encodeAbiParameters,
  parseTransaction,
  type EIP1193RequestFn,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

import { BAMClient } from '../../src/contracts/client.js';
import { ECDSA_REGISTRY_ABI } from '../../src/contracts/abis.js';
import type { Address, Bytes32 } from '../../src/types.js';

type Call = { method: string; params: readonly unknown[] };

const REGISTRY: Address = '0x00000000000000000000000000000000000000aa';
const OWNER: Address = '0x00000000000000000000000000000000000000bb';
const DELEGATE: Address = '0x00000000000000000000000000000000000000cc';
const TX_HASH = ('0x' + '11'.repeat(32)) as `0x${string}`;
const HASH32: Bytes32 = ('0x' + '22'.repeat(32)) as Bytes32;
const SIG65 = ('0x' + '33'.repeat(65)) as `0x${string}`;

// viem-formatted log for a KeyRegistered(index=7, owner=OWNER, pubKey=delegate bytes)
function registeredLog(): unknown {
  const topics = encodeEventTopics({
    abi: ECDSA_REGISTRY_ABI,
    eventName: 'KeyRegistered',
    args: { owner: OWNER },
  });
  // non-indexed: pubKey (bytes), index (uint256)
  const data = encodeAbiParameters(
    [
      { type: 'bytes' },
      { type: 'uint256' },
    ],
    [DELEGATE as `0x${string}`, 7n]
  );
  return {
    address: REGISTRY,
    topics,
    data,
    blockNumber: '0x1',
    logIndex: '0x0',
    transactionIndex: '0x0',
    removed: false,
    transactionHash: TX_HASH,
    blockHash: ('0x' + 'ab'.repeat(32)) as `0x${string}`,
  };
}

function rotatedLog(newIndex: bigint): unknown {
  const topics = encodeEventTopics({
    abi: ECDSA_REGISTRY_ABI,
    eventName: 'KeyRotated',
    args: { owner: OWNER },
  });
  // non-indexed: oldDelegate (address), newDelegate (address), newIndex (uint256)
  const data = encodeAbiParameters(
    [
      { type: 'address' },
      { type: 'address' },
      { type: 'uint256' },
    ],
    [DELEGATE as `0x${string}`, DELEGATE as `0x${string}`, newIndex]
  );
  return {
    address: REGISTRY,
    topics,
    data,
    blockNumber: '0x1',
    logIndex: '0x0',
    transactionIndex: '0x0',
    removed: false,
    transactionHash: TX_HASH,
    blockHash: ('0x' + 'ab'.repeat(32)) as `0x${string}`,
  };
}

function makeClient(responders: Record<string, (params: readonly unknown[]) => unknown>): {
  client: BAMClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const request: EIP1193RequestFn = (async ({ method, params }) => {
    calls.push({ method, params: (params ?? []) as readonly unknown[] });
    if (responders[method]) return responders[method]((params ?? []) as readonly unknown[]);
    // sensible defaults
    switch (method) {
      case 'eth_chainId':
        return '0xaa36a7'; // sepolia
      case 'eth_blockNumber':
        return '0x1';
      case 'eth_getBlockByNumber':
        return { number: '0x1', hash: '0x' + 'ab'.repeat(32), timestamp: '0x1' };
      case 'eth_estimateGas':
        return '0x5208';
      case 'eth_maxPriorityFeePerGas':
        return '0x0';
      case 'eth_gasPrice':
        return '0x1';
      case 'eth_getTransactionCount':
        return '0x0';
      case 'eth_feeHistory':
        return { baseFeePerGas: ['0x1'], gasUsedRatio: [0] };
    }
    throw new Error(`unexpected RPC ${method}`);
  }) as EIP1193RequestFn;

  const privKey =
    ('0x' + '01'.repeat(32)) as `0x${string}`;
  const account = privateKeyToAccount(privKey);

  // Construct BAMClient with a fake transport; overwrite public/wallet clients.
  const stubbedClient = new (BAMClient as unknown as {
    new (opts: {
      chain: typeof sepolia;
      rpcUrl: string;
      coreAddress: Address;
      account: ReturnType<typeof privateKeyToAccount>;
    }): BAMClient;
  })({
    chain: sepolia,
    rpcUrl: 'http://stub',
    coreAddress: ('0x' + '00'.repeat(20)) as Address,
    account,
  });

  // Swap out the public / wallet clients for ones wired to our stub transport.
  const transport = custom({ request });
  const publicClient = createPublicClient({ chain: sepolia, transport });
  const walletClient = createWalletClient({ chain: sepolia, transport, account });
  (stubbedClient as unknown as { publicClient: unknown }).publicClient = publicClient;
  (stubbedClient as unknown as { walletClient: unknown }).walletClient = walletClient;

  return { client: stubbedClient, calls };
}

function findWriteCall(calls: Call[]): Call | undefined {
  return calls.find(
    (c) => c.method === 'eth_sendRawTransaction' || c.method === 'eth_sendTransaction'
  );
}

function findReadCall(calls: Call[]): Call | undefined {
  return calls.find((c) => c.method === 'eth_call');
}

function decodeWrittenCalldata(rawTxOrCall: Call) {
  // With viem's local account flow we get eth_sendRawTransaction with a
  // signed tx — decode calldata via parseTransaction.
  if (rawTxOrCall.method === 'eth_sendRawTransaction') {
    const tx = parseTransaction(rawTxOrCall.params[0] as `0x${string}`);
    return tx.data as `0x${string}`;
  }
  // eth_sendTransaction — params[0] is an object
  const params = rawTxOrCall.params[0] as { data: `0x${string}` };
  return params.data;
}

describe('BAMClient ECDSA registry wrappers', () => {
  let responders: Record<string, (params: readonly unknown[]) => unknown>;

  beforeEach(() => {
    responders = {
      eth_sendRawTransaction: () => TX_HASH,
      eth_getTransactionReceipt: () => ({
        status: '0x1',
        transactionHash: TX_HASH,
        blockNumber: '0x1',
        gasUsed: '0x5208',
        cumulativeGasUsed: '0x5208',
        logs: [],
        logsBloom: '0x' + '00'.repeat(256),
        contractAddress: null,
        from: ('0x' + '00'.repeat(20)) as `0x${string}`,
        to: REGISTRY,
        transactionIndex: '0x0',
        type: '0x2',
        effectiveGasPrice: '0x1',
        blockHash: ('0x' + 'ab'.repeat(32)) as `0x${string}`,
      }),
    };
  });

  it('registerEcdsaDelegate encodes ECDSARegistry.register calldata and returns index', async () => {
    responders.eth_getTransactionReceipt = () => ({
      status: '0x1',
      transactionHash: TX_HASH,
      blockNumber: '0x1',
      gasUsed: '0x5208',
      cumulativeGasUsed: '0x5208',
      logs: [registeredLog()],
      logsBloom: '0x' + '00'.repeat(256),
      contractAddress: null,
      from: ('0x' + '00'.repeat(20)) as `0x${string}`,
      to: REGISTRY,
      transactionIndex: '0x0',
      type: '0x2',
      effectiveGasPrice: '0x1',
      blockHash: ('0x' + 'ab'.repeat(32)) as `0x${string}`,
    });

    const { client, calls } = makeClient(responders);
    const index = await client.registerEcdsaDelegate(REGISTRY, DELEGATE, SIG65);

    expect(index).toBe(7n);

    const write = findWriteCall(calls);
    expect(write).toBeDefined();
    const data = decodeWrittenCalldata(write!);
    const decoded = decodeFunctionData({ abi: ECDSA_REGISTRY_ABI, data });
    expect(decoded.functionName).toBe('register');
    expect(decoded.args?.[0]).toBe(DELEGATE.toLowerCase());
    expect(decoded.args?.[1]).toBe(SIG65);
  });

  it('rotateEcdsaDelegate encodes ECDSARegistry.rotate calldata and returns newIndex', async () => {
    responders.eth_getTransactionReceipt = () => ({
      status: '0x1',
      transactionHash: TX_HASH,
      blockNumber: '0x1',
      gasUsed: '0x5208',
      cumulativeGasUsed: '0x5208',
      logs: [rotatedLog(42n)],
      logsBloom: '0x' + '00'.repeat(256),
      contractAddress: null,
      from: ('0x' + '00'.repeat(20)) as `0x${string}`,
      to: REGISTRY,
      transactionIndex: '0x0',
      type: '0x2',
      effectiveGasPrice: '0x1',
      blockHash: ('0x' + 'ab'.repeat(32)) as `0x${string}`,
    });

    const { client, calls } = makeClient(responders);
    const newIndex = await client.rotateEcdsaDelegate(REGISTRY, DELEGATE, SIG65);

    expect(newIndex).toBe(42n);

    const write = findWriteCall(calls);
    expect(write).toBeDefined();
    const data = decodeWrittenCalldata(write!);
    const decoded = decodeFunctionData({ abi: ECDSA_REGISTRY_ABI, data });
    expect(decoded.functionName).toBe('rotate');
  });

  it('verifyEcdsa issues eth_call to ECDSARegistry.verify', async () => {
    // bool true → 32-byte word with 0x..01
    const trueResult = ('0x' + '00'.repeat(31) + '01') as `0x${string}`;
    responders.eth_call = () => trueResult;

    const { client, calls } = makeClient(responders);
    const ok = await client.verifyEcdsa(REGISTRY, DELEGATE, HASH32, SIG65);
    expect(ok).toBe(true);

    const read = findReadCall(calls);
    expect(read).toBeDefined();
    const { to, data } = read!.params[0] as { to: Address; data: `0x${string}` };
    expect(to.toLowerCase()).toBe(REGISTRY.toLowerCase());
    const decoded = decodeFunctionData({ abi: ECDSA_REGISTRY_ABI, data });
    expect(decoded.functionName).toBe('verify');
    expect(decoded.args?.[0]).toBe(DELEGATE.toLowerCase());
    expect(decoded.args?.[1]).toBe(HASH32);
    expect(decoded.args?.[2]).toBe(SIG65);
  });

  it('verifyEcdsaWithRegisteredKey issues eth_call to verifyWithRegisteredKey', async () => {
    responders.eth_call = () => ('0x' + '00'.repeat(32)) as `0x${string}`; // false

    const { client, calls } = makeClient(responders);
    const ok = await client.verifyEcdsaWithRegisteredKey(REGISTRY, OWNER, HASH32, SIG65);
    expect(ok).toBe(false);

    const read = findReadCall(calls);
    expect(read).toBeDefined();
    const { data } = read!.params[0] as { data: `0x${string}` };
    const decoded = decodeFunctionData({ abi: ECDSA_REGISTRY_ABI, data });
    expect(decoded.functionName).toBe('verifyWithRegisteredKey');
    expect(decoded.args?.[0]).toBe(OWNER.toLowerCase());
  });

  it('hasEcdsaDelegate issues eth_call to hasDelegate(owner)', async () => {
    responders.eth_call = () => ('0x' + '00'.repeat(31) + '01') as `0x${string}`;

    const { client, calls } = makeClient(responders);
    const ok = await client.hasEcdsaDelegate(REGISTRY, OWNER);
    expect(ok).toBe(true);

    const read = findReadCall(calls);
    expect(read).toBeDefined();
    const { to, data } = read!.params[0] as { to: Address; data: `0x${string}` };
    expect(to.toLowerCase()).toBe(REGISTRY.toLowerCase());
    const decoded = decodeFunctionData({ abi: ECDSA_REGISTRY_ABI, data });
    expect(decoded.functionName).toBe('hasDelegate');
    expect(decoded.args?.[0]).toBe(OWNER.toLowerCase());
  });

});
