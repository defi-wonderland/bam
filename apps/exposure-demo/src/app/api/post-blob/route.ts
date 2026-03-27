import { NextResponse } from 'next/server';
import {
  encodeExposureBatch,
  bytesToHex,
  loadTrustedSetup,
  createBlob,
  commitToBlob,
} from 'bam-sdk';
import type { ExposureMessage } from 'bam-sdk';
import {
  createWalletClient,
  createPublicClient,
  http,
  toBlobs,
  parseGwei,
  encodeFunctionData,
  type Kzg,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import {
  getPendingMessages,
  createBlob as createBlobRecord,
  updateBlobStatus,
  markMessagesPosted,
  getLastConfirmedBlob,
} from '@/db';
import { SOCIAL_BLOBS_CORE_ADDRESS } from '@/lib/constants';

const COOLDOWN_MS = 60_000;

const REGISTER_BLOB_ABI = [
  {
    type: 'function',
    name: 'registerBlob',
    inputs: [{ name: 'blobIndex', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

export async function POST() {
  try {
    // Rate limit
    const lastBlob = getLastConfirmedBlob();
    if (lastBlob) {
      const elapsed = Date.now() - new Date(lastBlob.created_at).getTime();
      if (elapsed < COOLDOWN_MS) {
        const remaining = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
        return NextResponse.json(
          { error: `Rate limited. Try again in ${remaining} seconds.` },
          { status: 429 }
        );
      }
    }

    const pending = getPendingMessages();
    if (pending.length === 0) {
      return NextResponse.json({ error: 'No pending messages' }, { status: 400 });
    }

    const posterKey = process.env.POSTER_PRIVATE_KEY;
    if (!posterKey) {
      return NextResponse.json({ error: 'Server wallet not configured' }, { status: 500 });
    }

    const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;
    if (!rpcUrl) {
      return NextResponse.json(
        { error: 'NEXT_PUBLIC_RPC_URL is required for blob transactions' },
        { status: 500 }
      );
    }

    // Convert DB messages to ExposureMessages for exposure batch encoding.
    // Messages are stored in on-chain raw format for KZG-verifiable exposure.
    const exposureMessages: ExposureMessage[] = pending.map((m) => ({
      author: m.author as `0x${string}`,
      timestamp: m.timestamp,
      nonce: m.nonce,
      content: m.content,
    }));

    const batch = encodeExposureBatch(exposureMessages);
    const batchData = batch.data;

    loadTrustedSetup();
    const blob = createBlob(batchData);
    const { commitment } = commitToBlob(blob);

    const blobId = bytesToHex(commitment).slice(0, 18);

    const account = privateKeyToAccount(posterKey as `0x${string}`);
    const walletClient = createWalletClient({
      account,
      chain: sepolia,
      transport: http(rpcUrl),
    });
    const publicClient = createPublicClient({
      chain: sepolia,
      transport: http(rpcUrl),
    });

    const kzg = await getKzgForViem();
    const blobData = toBlobs({ data: batchData });

    const registerData = encodeFunctionData({
      abi: REGISTER_BLOB_ABI,
      functionName: 'registerBlob',
      args: [0n],
    });

    const hash = await walletClient.sendTransaction({
      to: SOCIAL_BLOBS_CORE_ADDRESS,
      data: registerData,
      blobs: blobData,
      maxFeePerBlobGas: parseGwei('30'),
      kzg,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    // Extract versioned hash from tx
    const tx = await publicClient.getTransaction({ hash });
    const versionedHash = tx.blobVersionedHashes?.[0] ?? null;

    await createBlobRecord(blobId, pending.length);
    await updateBlobStatus(
      blobId,
      'confirmed',
      receipt.transactionHash,
      Number(receipt.blockNumber),
      versionedHash ?? undefined
    );
    await markMessagesPosted(
      pending.map((m) => m.message_id),
      blobId
    );

    return NextResponse.json({
      blobId,
      txHash: receipt.transactionHash,
      blockNumber: Number(receipt.blockNumber),
      versionedHash,
      messageCount: pending.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Post blob failed:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function getKzgForViem(): Promise<Kzg> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cKzg = require('c-kzg');
  return {
    blobToKzgCommitment: cKzg.blobToKzgCommitment,
    computeBlobKzgProof: cKzg.computeBlobKzgProof,
  };
}
