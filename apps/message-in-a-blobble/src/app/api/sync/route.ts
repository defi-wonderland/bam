import { NextResponse } from 'next/server';
import { createPublicClient, http, parseAbiItem } from 'viem';
import { sepolia } from 'viem/chains';
import { decodeBatch, computeMessageId } from 'bam-sdk';
import { SOCIAL_BLOBS_CORE_ADDRESS } from '@/lib/constants';
import { fetchBlobForTx, extractUsableBytes } from '@/lib/blob-fetch';
import {
  getSyncedBlobbleTxHashes,
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
    const knownTxHashes = new Set(await getSyncedBlobbleTxHashes());

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
    const knownTxHashes = new Set(await getSyncedBlobbleTxHashes());

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
        console.log(`[sync] Processing tx ${blobble.txHash} (block ${blobble.blockNumber})`);

        const blobData = await fetchBlobForTx(blobble.txHash);

        if (!blobData) {
          console.warn(`[sync] No blob data available for tx ${blobble.txHash}`);
          results.push({ txHash: blobble.txHash, status: 'blob_unavailable' });
          continue;
        }

        console.log(`[sync] Fetched blob data: ${blobData.length} bytes`);

        const usableBytes = extractUsableBytes(blobData);
        const decoded = decodeBatch(usableBytes);

        console.log(`[sync] Decoded ${decoded.messages.length} messages from tx ${blobble.txHash}`);

        if (decoded.messages.length === 0) {
          console.warn(`[sync] 0 messages decoded from tx ${blobble.txHash} — blob may be corrupt or not a BAM batch`);
        }

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

        console.log(`[sync] Stored blobble ${blobbleId} with ${decoded.messages.length} messages`);

        results.push({
          txHash: blobble.txHash,
          status: 'synced',
          messageCount: decoded.messages.length,
        });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[sync] Failed to sync tx ${blobble.txHash}:`, errMsg);
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
