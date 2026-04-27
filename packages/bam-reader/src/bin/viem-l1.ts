/**
 * Adapt viem's `publicClient` to the `LiveTailL1Client` shape the
 * Reader's loops + reorg watcher expect. Lives under `src/bin/`
 * because it's CLI-only — library consumers wire their own clients.
 */

import {
  createPublicClient,
  http,
  parseAbi,
  type Hash,
  type PublicClient,
} from 'viem';
import type { Address, Bytes32 } from 'bam-sdk';

import {
  BLOB_BATCH_REGISTERED_EVENT,
} from '../discovery/log-scan.js';
import type { LiveTailL1Client } from '../loop/live-tail.js';
import type { ReadContractClient } from '../decode/on-chain-decoder.js';
import type { VerifyReadContractClient } from '../verify/on-chain-registry.js';

const PARENT_BEACON_FN = parseAbi([
  'function parentBeaconBlockRoot() view returns (bytes32)',
])[0];
void PARENT_BEACON_FN; // referenced for lint awareness; the real call goes through `getBlock`.

export interface ViemL1Adapter {
  l1: LiveTailL1Client;
  decodePublicClient: ReadContractClient;
  verifyPublicClient: VerifyReadContractClient;
  close(): Promise<void>;
}

export function createViemL1(rpcUrl: string): ViemL1Adapter {
  const publicClient: PublicClient = createPublicClient({
    chain: undefined,
    transport: http(rpcUrl),
  });

  const l1: LiveTailL1Client = {
    async getChainId() {
      return Number(await publicClient.getChainId());
    },
    async getBlockNumber() {
      return publicClient.getBlockNumber();
    },
    async getTransactionBlock(txHash: Bytes32) {
      const receipt = await publicClient
        .getTransactionReceipt({ hash: txHash as Hash })
        .catch(() => null);
      if (!receipt) return null;
      return Number(receipt.blockNumber);
    },
    async getParentBeaconBlockRoot(blockNumber: number) {
      const block = await publicClient.getBlock({
        blockNumber: BigInt(blockNumber),
      });
      const root = (block as { parentBeaconBlockRoot?: string })
        .parentBeaconBlockRoot;
      return (root ?? null) as Bytes32 | null;
    },
    async getLogs(args) {
      const logs = await publicClient.getLogs({
        address: args.address,
        event: BLOB_BATCH_REGISTERED_EVENT,
        args: args.args?.contentTag
          ? { contentTag: [...args.args.contentTag] as Hash[] }
          : undefined,
        fromBlock: args.fromBlock,
        toBlock: args.toBlock,
      });
      return logs.map((l) => ({
        blockNumber: l.blockNumber!,
        transactionIndex: l.transactionIndex!,
        logIndex: l.logIndex!,
        transactionHash: l.transactionHash as Bytes32,
        args: {
          versionedHash: l.args.versionedHash as Bytes32,
          submitter: l.args.submitter as Address,
          contentTag: l.args.contentTag as Bytes32,
          decoder: l.args.decoder as Address,
          signatureRegistry: l.args.signatureRegistry as Address,
        },
      }));
    },
  };

  // viem's `readContract` does not accept a `gas` cap; properly
  // bounding eth_call gas would require dropping to `publicClient.call`
  // and decoding manually. For MVP we drop the gas argument and rely
  // on the wallclock-timeout bound enforced by the dispatch layers.
  // Tracked as a follow-up: tighten gas bound through `publicClient.call`.
  const decodePublicClient: ReadContractClient = {
    async readContract(args) {
      return publicClient.readContract({
        address: args.address as Address,
        abi: args.abi,
        functionName: args.functionName,
        args: args.args,
      }) as ReturnType<ReadContractClient['readContract']>;
    },
  };

  const verifyPublicClient: VerifyReadContractClient = {
    async readContract(args) {
      return publicClient.readContract({
        address: args.address as Address,
        abi: args.abi,
        functionName: args.functionName,
        args: args.args,
      });
    },
  };

  return {
    l1,
    decodePublicClient,
    verifyPublicClient,
    async close() {
      // viem clients have no resources to release.
    },
  };
}
