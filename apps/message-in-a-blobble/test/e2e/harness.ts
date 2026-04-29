import {
  HttpServer,
  LocalEcdsaSigner,
  _clearSignerRegistryForTests,
  createMemoryStore,
  createPoster,
  defaultBatchPolicy,
  type BlockSource,
  type BuildAndSubmit,
  type Poster,
  type PosterFactoryExtras,
} from '@bam/poster';
import type { Address, Bytes32 } from 'bam-sdk';
import { generateECDSAPrivateKey } from 'bam-sdk';

import { MESSAGE_IN_A_BLOBBLE_TAG } from '../../src/lib/constants';

export interface Harness {
  close: () => Promise<void>;
  port: number;
  /** tx hash to be returned on next buildAndSubmit call */
  nextTxHash: () => Bytes32;
  /** number of buildAndSubmit calls so far */
  submissions: () => number;
  /** call the Poster's internal tick to force a submission */
  flush: () => Promise<void>;
  poster: Poster;
}

/**
 * Demo e2e harness:
 *   - In-process Poster with the memory store + `forceFlush` batch
 *     policy so tests can deterministically trigger a submission.
 *   - Mocked `buildAndSubmit` that pretends to land on L1 and
 *     records the call.
 *   - HTTP transport mounted on a random port; `POSTER_URL` set
 *     accordingly so the demo's proxy routes forward to it.
 */
export async function startHarness(): Promise<Harness> {
  _clearSignerRegistryForTests();

  let counter = 0;
  const calls: Array<{ tag: Bytes32; messageIds: Bytes32[] }> = [];
  const includedTxs = new Map<Bytes32, number>();
  const nextTxHash = (): Bytes32 =>
    (`0x${(++counter).toString(16).padStart(64, '0')}`) as Bytes32;

  const buildAndSubmit: BuildAndSubmit = async ({ contentTag, messages }) => {
    const txHash = nextTxHash();
    const blockNumber = 100 + counter;
    includedTxs.set(txHash, blockNumber);
    calls.push({ tag: contentTag, messageIds: messages.map((m) => m.messageId) });
    return {
      kind: 'included',
      txHash,
      blobVersionedHash: (`0x${'fe'.repeat(32)}`) as Bytes32,
      blockNumber,
      txIndex: 0,
      submitter: ('0x' + 'cd'.repeat(20)) as Address,
    };
  };

  const blockSource: BlockSource = {
    getBlockNumber: async () => BigInt(100 + counter),
    getTransactionBlock: async (txHash) =>
      includedTxs.has(txHash) ? (includedTxs.get(txHash) ?? null) : null,
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
    getBlockNumber: blockSource.getBlockNumber,
    getTransactionBlock: blockSource.getTransactionBlock,
  };

  const pk = generateECDSAPrivateKey() as `0x${string}`;
  const signer = new LocalEcdsaSigner(pk);
  const poster = await createPoster(
    {
      allowlistedTags: [MESSAGE_IN_A_BLOBBLE_TAG as unknown as Bytes32],
      chainId: 1,
      bamCoreAddress: '0x9C4b230066a6808D83F5FBa0c040E0Df2Fcc7314' as Address,
      signer,
      store: await createMemoryStore(),
      batchPolicy: defaultBatchPolicy({ forceFlush: true }),
    },
    { buildAndSubmit, rpc }
  );
  // NOTE: intentionally do NOT call `poster.start()`. The scheduler is
  // dormant so test ticks driven via `_tickTag` are deterministic.

  const server = new HttpServer({ poster, maxMessageSizeBytes: 120_000 });
  await server.listen(0);
  const addr = server.address();
  if (!addr) throw new Error('no server address');

  process.env.POSTER_URL = `http://127.0.0.1:${addr.port}`;

  const internal = poster as unknown as {
    _tickTag: (tag: Bytes32) => Promise<void>;
  };

  return {
    port: addr.port,
    nextTxHash: () => {
      const prev = counter;
      return (`0x${(prev + 1).toString(16).padStart(64, '0')}`) as Bytes32;
    },
    submissions: () => calls.length,
    flush: async () => {
      await internal._tickTag(MESSAGE_IN_A_BLOBBLE_TAG as unknown as Bytes32);
    },
    poster,
    close: async () => {
      delete process.env.POSTER_URL;
      await server.close();
      await poster.stop();
    },
  };
}
