/**
 * Adapt viem's `publicClient` to the `LiveTailL1Client` shape the
 * Reader's loops + reorg watcher expect. Lives under `src/bin/`
 * because it's CLI-only — library consumers wire their own clients.
 */

import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  http,
  parseAbi,
  type Hash,
  type PublicClient,
} from 'viem';
import type { Address, Bytes32 } from 'bam-sdk';

import {
  BLOB_BATCH_REGISTERED_EVENT,
  BLOB_SEGMENT_DECLARED_EVENT,
} from '../discovery/log-scan.js';
import type { LiveTailL1Client } from '../loop/live-tail.js';
import type { ReadContractClient } from '../decode/on-chain-decoder.js';
import {
  VERIFY_WITH_REGISTERED_KEY_ABI,
  type VerifyReadContractClient,
} from '../verify/on-chain-registry.js';

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
    async getBlockHeader(blockNumber: number) {
      // Let RPC errors propagate — the live-tail / backfill loops are
      // already wrapped in tick-level try/catch that retries on the
      // next poll interval. Swallowing errors here would advance the
      // cursor with `l1IncludedAtUnixSec=null`, leaving a permanent
      // gap on a transient RPC blip (qodo PR #28). Same posture as
      // every other method on this adapter.
      const block = await publicClient.getBlock({
        blockNumber: BigInt(blockNumber),
      });
      const root = (block as { parentBeaconBlockRoot?: string })
        .parentBeaconBlockRoot;
      return {
        parentBeaconBlockRoot: (root ?? null) as Bytes32 | null,
        timestampUnixSec: Number(block.timestamp),
      };
    },
    async getLogs(args) {
      // One `eth_getLogs` with OR'd topic[0] returns both event types
      // as a discriminated union keyed by `eventName`. viem's `[a, b]`
      // overload narrows `args` to `undefined`; the cast bypasses it
      // — runtime correctly filters topic[3] (contentTag).
      const tagFilter =
        args.args?.contentTag !== undefined
          ? { contentTag: [...args.args.contentTag] as Hash[] }
          : undefined;
      const logs = await publicClient.getLogs({
        address: args.address,
        events: [BLOB_BATCH_REGISTERED_EVENT, BLOB_SEGMENT_DECLARED_EVENT],
        args: tagFilter as never,
        fromBlock: args.fromBlock,
        toBlock: args.toBlock,
      });
      return logs.map((l) => {
        if (l.eventName === 'BlobBatchRegistered') {
          const a = l.args as {
            versionedHash: Hash;
            submitter: Hash;
            contentTag: Hash;
            decoder: Hash;
            signatureRegistry: Hash;
          };
          return {
            eventName: 'BlobBatchRegistered' as const,
            blockNumber: l.blockNumber!,
            transactionIndex: l.transactionIndex!,
            logIndex: l.logIndex!,
            transactionHash: l.transactionHash as Bytes32,
            args: {
              versionedHash: a.versionedHash as Bytes32,
              submitter: a.submitter as Address,
              contentTag: a.contentTag as Bytes32,
              decoder: a.decoder as Address,
              signatureRegistry: a.signatureRegistry as Address,
            },
          };
        }
        // 'BlobSegmentDeclared'
        const a = l.args as {
          versionedHash: Hash;
          declarer: Hash;
          startFE: number | bigint;
          endFE: number | bigint;
          contentTag: Hash;
        };
        return {
          eventName: 'BlobSegmentDeclared' as const,
          blockNumber: l.blockNumber!,
          transactionIndex: l.transactionIndex!,
          logIndex: l.logIndex!,
          transactionHash: l.transactionHash as Bytes32,
          args: {
            versionedHash: a.versionedHash as Bytes32,
            declarer: a.declarer as Address,
            startFE: Number(a.startFE),
            endFE: Number(a.endFE),
            contentTag: a.contentTag as Bytes32,
          },
        };
      });
    },
  };

  // viem's `readContract` strips the `gas` parameter (its
  // `ReadContractParameters` type only picks specific fields from
  // `CallParameters`, and `gas` is not among them). To actually
  // enforce `READER_ETH_CALL_GAS_CAP` (red-team C-10) we drop to
  // `publicClient.call({ to, data, gas })` and ABI-encode/decode by
  // hand. Without this, the gas argument the dispatch layer passes
  // is silently ignored.
  const decodePublicClient: ReadContractClient = {
    async readContract(args) {
      const data = encodeFunctionData({
        abi: args.abi,
        functionName: args.functionName,
        args: args.args,
      });
      const { data: returnData } = await publicClient.call({
        to: args.address as Address,
        data,
        gas: args.gas,
      });
      if (!returnData) {
        throw new Error(`empty return data from ${args.address}`);
      }
      return decodeFunctionResult({
        abi: args.abi,
        functionName: args.functionName,
        data: returnData,
      }) as Awaited<ReturnType<ReadContractClient['readContract']>>;
    },
  };

  const verifyPublicClient: VerifyReadContractClient = {
    async readContract(args) {
      const data = encodeFunctionData({
        abi: VERIFY_WITH_REGISTERED_KEY_ABI,
        functionName: args.functionName,
        args: args.args,
      });
      const { data: returnData } = await publicClient.call({
        to: args.address as Address,
        data,
        gas: args.gas,
      });
      if (!returnData) {
        throw new Error(`empty return data from ${args.address}`);
      }
      return decodeFunctionResult({
        abi: VERIFY_WITH_REGISTERED_KEY_ABI,
        functionName: args.functionName,
        data: returnData,
      }) as boolean;
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
