import { NextResponse } from 'next/server';
import { createPublicClient, http, parseAbiItem } from 'viem';
import { sepolia } from 'viem/chains';
import { BLS_EXPOSER_ADDRESS } from '@/lib/constants';

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
      address: BLS_EXPOSER_ADDRESS,
      event: parseAbiItem(
        'event MessageExposed(bytes32 indexed contentHash, bytes32 indexed messageId, address indexed author, address exposer, uint64 timestamp)'
      ),
      fromBlock,
      toBlock: 'latest',
    });

    const exposures = logs.map((log) => ({
      contentHash: log.args.contentHash,
      messageId: log.args.messageId,
      author: log.args.author,
      exposer: log.args.exposer,
      timestamp: Number(log.args.timestamp),
      txHash: log.transactionHash,
      blockNumber: Number(log.blockNumber),
    }));

    exposures.reverse();

    return NextResponse.json({ exposures });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Failed to fetch exposures:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
