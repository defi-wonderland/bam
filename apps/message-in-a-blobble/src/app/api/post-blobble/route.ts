import { NextResponse } from 'next/server';
import {
  encodeBatch,
  bytesToHex,
  hexToBytes,
  loadTrustedSetup,
  createBlob,
  commitToBlob,
} from 'bam-sdk';
import type { SignedMessage, Address } from 'bam-sdk';
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
  createBlobble,
  updateBlobbleStatus,
  markMessagesPosted,
} from '@/db/queries';
import { SOCIAL_BLOBS_CORE_ADDRESS } from '@/lib/constants';

const SOCIAL_BLOBS_CORE_ABI = [
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
    const pending = getPendingMessages();
    if (pending.length === 0) {
      return NextResponse.json(
        { error: 'No pending messages' },
        { status: 400 }
      );
    }

    const posterKey = process.env.POSTER_PRIVATE_KEY;
    if (!posterKey) {
      return NextResponse.json(
        { error: 'Server wallet not configured' },
        { status: 500 }
      );
    }

    const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;
    if (!rpcUrl) {
      return NextResponse.json(
        { error: 'NEXT_PUBLIC_RPC_URL is required for blob transactions (public RPCs do not reliably support EIP-4844)' },
        { status: 500 }
      );
    }

    // Convert DB messages to SignedMessages for batch encoding
    const signedMessages: SignedMessage[] = pending.map((m) => ({
      author: m.author as Address,
      timestamp: m.timestamp,
      nonce: m.nonce,
      content: m.content,
      signature: hexToBytes(m.signature),
      signatureType: 'ecdsa' as const,
    }));

    const batch = encodeBatch(signedMessages);
    const batchData = batch.data;

    loadTrustedSetup();
    const blob = createBlob(batchData);
    const { commitment } = commitToBlob(blob);

    const blobbleId = bytesToHex(commitment).slice(0, 18);

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

    // Encode registerBlob(0) calldata so the blob tx also registers in one transaction
    const registerData = encodeFunctionData({
      abi: SOCIAL_BLOBS_CORE_ABI,
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

    createBlobble(blobbleId, pending.length);
    updateBlobbleStatus(
      blobbleId,
      'confirmed',
      receipt.transactionHash,
      Number(receipt.blockNumber)
    );
    markMessagesPosted(
      pending.map((m) => m.message_id),
      blobbleId
    );

    return NextResponse.json({
      blobbleId,
      txHash: receipt.transactionHash,
      blockNumber: Number(receipt.blockNumber),
      messageCount: pending.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Post blobble failed:', message);
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
