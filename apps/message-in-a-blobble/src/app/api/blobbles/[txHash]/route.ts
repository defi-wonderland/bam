import { NextRequest, NextResponse } from 'next/server';
import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';
import { decodeBatch } from 'bam-sdk';
import { fetchBlobForTx, extractUsableBytes } from '@/lib/blob-fetch';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ txHash: string }> }
) {
  try {
    const { txHash } = await params;
    const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL || undefined;
    const publicClient = createPublicClient({
      chain: sepolia,
      transport: http(rpcUrl),
    });

    const receipt = await publicClient.getTransactionReceipt({
      hash: txHash as `0x${string}`,
    });

    if (!receipt) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
    }

    const tx = await publicClient.getTransaction({
      hash: txHash as `0x${string}`,
    });

    const blobVersionedHashes = tx.blobVersionedHashes;
    if (!blobVersionedHashes || blobVersionedHashes.length === 0) {
      return NextResponse.json({ error: 'No blobs in this transaction' }, { status: 400 });
    }

    const blobData = await fetchBlobForTx(txHash);

    if (!blobData) {
      return NextResponse.json({
        txHash,
        blockNumber: Number(receipt.blockNumber),
        blobVersionedHashes,
        messages: null,
        note: 'Blob data not available (blobs are pruned after ~18 days, or RPC does not support blob retrieval)',
      });
    }

    const usableBytes = extractUsableBytes(blobData);
    const decoded = decodeBatch(usableBytes);

    const messages = decoded.messages.map((m) => ({
      author: m.author,
      content: m.content,
      timestamp: m.timestamp,
      nonce: m.nonce,
    }));

    return NextResponse.json({
      txHash,
      blockNumber: Number(receipt.blockNumber),
      blobVersionedHashes,
      messageCount: messages.length,
      messages,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Failed to fetch blobble details:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
