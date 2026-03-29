import { NextRequest, NextResponse } from 'next/server';
import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';
import {
  loadTrustedSetup,
  parseBlob,
  buildExposureParamsRaw,
  bytesToHex,
} from 'bam-sdk';
import { fetchBlobForTx } from '@/lib/blob-fetch';

/**
 * POST /api/exposure/build
 *
 * Builds ExposureParams (KZG proofs) for a specific message in a blob.
 * The client provides the txHash and message index; the server fetches
 * the blob, parses it, generates KZG proofs, and returns serialized params.
 *
 * Request body: { txHash: string, messageIndex: number }
 * Response: serialized ExposureParams (hex-encoded fields)
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { txHash, messageIndex } = body as {
      txHash: string;
      messageIndex: number;
    };

    if (!txHash || messageIndex === undefined) {
      return NextResponse.json(
        { error: 'Missing required fields: txHash, messageIndex' },
        { status: 400 }
      );
    }

    const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL || undefined;
    const publicClient = createPublicClient({
      chain: sepolia,
      transport: http(rpcUrl),
    });

    // Get versioned hash from transaction
    const tx = await publicClient.getTransaction({
      hash: txHash as `0x${string}`,
    });
    const versionedHash = tx.blobVersionedHashes?.[0];
    if (!versionedHash) {
      return NextResponse.json(
        { error: 'No blob versioned hashes in transaction' },
        { status: 400 }
      );
    }

    // Fetch raw blob data
    const blobData = await fetchBlobForTx(txHash);
    if (!blobData) {
      return NextResponse.json(
        { error: 'Blob data not available (may have been pruned)' },
        { status: 404 }
      );
    }

    // Parse blob to extract messages with byte positions
    loadTrustedSetup();
    const parsedBlob = parseBlob(blobData, { versionedHash });

    if (messageIndex >= parsedBlob.messages.length) {
      return NextResponse.json(
        { error: `Message index ${messageIndex} out of range (${parsedBlob.messages.length} messages)` },
        { status: 400 }
      );
    }

    const message = parsedBlob.messages[messageIndex];

    // Build exposure params with KZG proofs.
    // We pass a dummy BLS signature — the client will provide the real one.
    const dummySignature = new Uint8Array(96);
    const params = buildExposureParamsRaw(
      blobData,
      message.byteOffset,
      message.rawBytes,
      dummySignature,
      versionedHash as `0x${string}`,
      parsedBlob.batchStartOffset
    );

    // Serialize for JSON transport
    return NextResponse.json({
      versionedHash: params.versionedHash,
      kzgProofs: params.kzgProofs.map((p) => ({
        z: p.z.toString(),
        y: p.y.toString(),
        commitment: bytesToHex(p.commitment),
        proof: bytesToHex(p.proof),
      })),
      batchStartOffset: params.batchStartOffset,
      byteOffset: params.byteOffset,
      byteLength: params.byteLength,
      messageBytes: bytesToHex(params.messageBytes),
      // Message metadata for client-side hash computation
      message: {
        author: message.author,
        timestamp: message.timestamp,
        nonce: message.nonce,
        content: message.content,
        messageHash: message.messageHash,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Failed to build exposure params:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
