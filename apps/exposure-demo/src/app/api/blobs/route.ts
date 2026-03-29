import { NextResponse } from 'next/server';
import { createPublicClient, http, parseAbiItem } from 'viem';
import { sepolia } from 'viem/chains';
import { SOCIAL_BLOBS_CORE_ADDRESS } from '@/lib/constants';

export async function GET() {
  try {
    const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL || undefined;
    const publicClient = createPublicClient({
      chain: sepolia,
      transport: http(rpcUrl),
    });

    const currentBlock = await publicClient.getBlockNumber();
    const fromBlock = currentBlock - 7200n > 0n ? currentBlock - 7200n : 0n;

    const logs = await publicClient.getLogs({
      address: SOCIAL_BLOBS_CORE_ADDRESS,
      event: parseAbiItem(
        'event BlobRegistered(bytes32 indexed versionedHash, address indexed submitter, uint64 timestamp)'
      ),
      fromBlock,
      toBlock: 'latest',
    });

    const blobs = logs.map((log) => ({
      versionedHash: log.args.versionedHash,
      submitter: log.args.submitter,
      timestamp: Number(log.args.timestamp),
      txHash: log.transactionHash,
      blockNumber: Number(log.blockNumber),
    }));

    blobs.reverse();

    return NextResponse.json({ blobs });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Failed to fetch blobs:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
