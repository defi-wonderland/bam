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

    // Fetch unique block timestamps under bounded concurrency so a
    // window with many distinct event-carrying blocks can't fan out
    // into thousands of simultaneous RPC calls and trip rate limits
    // (qodo review). Memoize so duplicate events in the same block
    // reuse a single fetch.
    const uniqueBlocks = Array.from(new Set(logs.map((l) => l.blockNumber)));
    const timestampByBlock = new Map<bigint, number>();
    const RPC_CONCURRENCY = 8;
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(RPC_CONCURRENCY, uniqueBlocks.length) },
      async () => {
        while (true) {
          const i = cursor++;
          if (i >= uniqueBlocks.length) return;
          const blk = uniqueBlocks[i];
          const b = await client.getBlock({ blockNumber: blk });
          timestampByBlock.set(blk, Number(b.timestamp));
        }
      }
    );
    await Promise.all(workers);

    const blobbles: Blobble[] = logs.map((log) => ({
      versionedHash: log.args.versionedHash!,
      submitter: log.args.submitter!,
      timestamp: timestampByBlock.get(log.blockNumber) ?? 0,
      txHash: log.transactionHash,
      blockNumber: Number(log.blockNumber),
    }));

    blobbles.sort((a, b) => b.blockNumber - a.blockNumber);

    return NextResponse.json({ blobbles });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Failed to fetch blobbles:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
