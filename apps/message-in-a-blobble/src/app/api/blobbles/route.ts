import { NextResponse } from 'next/server';
import { createPublicClient, http, parseAbiItem } from 'viem';
import { sepolia } from 'viem/chains';
import { BAM_CORE_ADDRESS, MESSAGE_IN_A_BLOBBLE_TAG } from '@/lib/constants';

interface Blobble {
  versionedHash: string;
  submitter: string;
  timestamp: number;
  txHash: string;
  blockNumber: number;
}

/**
 * Read path for the amended ERC-8180 BAM core: filter
 * `BlobBatchRegistered` by this app's content tag, window the last
 * ~day of blocks, enrich with block timestamps (the event dropped
 * the explicit `timestamp` field the legacy contract had).
 */
export async function GET() {
  try {
    const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL || undefined;
    const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });

    if (BAM_CORE_ADDRESS === '0x0000000000000000000000000000000000000000') {
      return NextResponse.json(
        { error: 'NEXT_PUBLIC_BAM_CORE_ADDRESS is not configured' },
        { status: 500 }
      );
    }

    const head = await client.getBlockNumber();
    // Look back ~1 day of blocks (12 s each).
    const fromBlock = head - 7200n > 0n ? head - 7200n : 0n;

    const logs = await client.getLogs({
      address: BAM_CORE_ADDRESS,
      event: parseAbiItem(
        'event BlobBatchRegistered(bytes32 indexed versionedHash, address indexed submitter, bytes32 indexed contentTag, address decoder, address signatureRegistry)'
      ),
      args: { contentTag: MESSAGE_IN_A_BLOBBLE_TAG },
      fromBlock,
      toBlock: 'latest',
    });

    // Memoize block timestamps — several events in the same block
    // shouldn't hit the RPC twice.
    const blockCache = new Map<bigint, Promise<number>>();
    const timestampOf = (blk: bigint): Promise<number> => {
      let p = blockCache.get(blk);
      if (!p) {
        p = client.getBlock({ blockNumber: blk }).then((b) => Number(b.timestamp));
        blockCache.set(blk, p);
      }
      return p;
    };

    const blobbles: Blobble[] = await Promise.all(
      logs.map(async (log) => ({
        versionedHash: log.args.versionedHash!,
        submitter: log.args.submitter!,
        timestamp: await timestampOf(log.blockNumber),
        txHash: log.transactionHash,
        blockNumber: Number(log.blockNumber),
      }))
    );

    blobbles.sort((a, b) => b.blockNumber - a.blockNumber);

    return NextResponse.json({ blobbles });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Failed to fetch blobbles:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
