import { NextResponse } from 'next/server';
import { createPublicClient, http, parseAbiItem } from 'viem';
import { sepolia } from 'viem/chains';
import { decodeBatch, computeMessageId } from 'bam-sdk';
import { SOCIAL_BLOBS_CORE_ADDRESS } from '@/lib/constants';
import { fetchBlobForTx, extractUsableBytes } from '@/lib/blob-fetch';
import {
  getAllBlobbleTxHashes,
  createBlobble,
  updateBlobbleStatus,
  insertSyncedMessage,
} from '@/db/queries';

interface OnChainBlobble {
  versionedHash: string;
  submitter: string;
  timestamp: number;
  txHash: string;
  blockNumber: number;
}

async function fetchOnChainBlobbles(): Promise<OnChainBlobble[]> {
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

  return logs.map((log) => ({
    versionedHash: log.args.versionedHash!,
    submitter: log.args.submitter!,
    timestamp: Number(log.args.timestamp),
    txHash: log.transactionHash,
    blockNumber: Number(log.blockNumber),
  }));
}

export async function GET() {
  try {
    const onChain = await fetchOnChainBlobbles();
    const knownTxHashes = new Set(await getAllBlobbleTxHashes());

    const missing = onChain.filter((b) => !knownTxHashes.has(b.txHash));

    return NextResponse.json({
      onChainCount: onChain.length,
      knownCount: knownTxHashes.size,
      missingCount: missing.length,
      missing: missing.map((b) => ({
        txHash: b.txHash,
        blockNumber: b.blockNumber,
        submitter: b.submitter,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST() {
  try {
    const onChain = await fetchOnChainBlobbles();
    const knownTxHashes = new Set(await getAllBlobbleTxHashes());

    const missing = onChain.filter((b) => !knownTxHashes.has(b.txHash));

    if (missing.length === 0) {
      return NextResponse.json({ synced: 0, message: 'Database is up to date' });
    }

    const results: Array<{
      txHash: string;
      status: 'synced' | 'blob_unavailable' | 'error';
      messageCount?: number;
      error?: string;
    }> = [];

    for (const blobble of missing) {
      try {
        const blobData = await fetchBlobForTx(blobble.txHash);

        if (!blobData) {
          results.push({ txHash: blobble.txHash, status: 'blob_unavailable' });
          continue;
        }

        const usableBytes = extractUsableBytes(blobData);
        const decoded = decodeBatch(usableBytes);

        // Use versionedHash prefix as blobble ID (consistent with post-blobble which uses commitment prefix)
        const blobbleId = blobble.versionedHash.slice(0, 18);

        await createBlobble(blobbleId, decoded.messages.length);
        await updateBlobbleStatus(
          blobbleId,
          'confirmed',
          blobble.txHash,
          blobble.blockNumber
        );

        for (const msg of decoded.messages) {
          const messageId = computeMessageId(msg);
          await insertSyncedMessage({
            message_id: messageId,
            author: msg.author,
            timestamp: msg.timestamp,
            nonce: msg.nonce,
            content: msg.content,
            blobble_id: blobbleId,
          });
        }

        results.push({
          txHash: blobble.txHash,
          status: 'synced',
          messageCount: decoded.messages.length,
        });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : 'Unknown error';
        results.push({ txHash: blobble.txHash, status: 'error', error: errMsg });
      }
    }

    const syncedCount = results.filter((r) => r.status === 'synced').length;
    const totalMessages = results
      .filter((r) => r.status === 'synced')
      .reduce((sum, r) => sum + (r.messageCount ?? 0), 0);

    return NextResponse.json({
      synced: syncedCount,
      totalMessages,
      results,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
