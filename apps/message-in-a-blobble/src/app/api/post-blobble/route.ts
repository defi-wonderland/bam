import { NextResponse } from 'next/server';
import {
  encodeBatch,
  bytesToHex,
  hexToBytes,
  loadTrustedSetup,
  createBlob,
  commitToBlob,
  BAM_CORE_ABI,
} from 'bam-sdk';
import type { SignedMessage, Address } from 'bam-sdk';
import {
  createWalletClient,
  createPublicClient,
  http,
  toBlobs,
  parseGwei,
  encodeFunctionData,
  zeroAddress,
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
import {
  BAM_CORE_ADDRESS,
  ECDSA_REGISTRY_ADDRESS,
  MESSAGE_IN_A_BLOBBLE_TAG,
} from '@/lib/constants';
import { COOLDOWN_MS, getLastPostTime } from '@/lib/poster-state';

export async function POST() {
  try {
    // Rate-limit: max once per minute
    const now = Date.now();
    const lastPostTime = await getLastPostTime();
    if (lastPostTime && now - lastPostTime < COOLDOWN_MS) {
      const remainingMs = COOLDOWN_MS - (now - lastPostTime);
      return NextResponse.json(
        { error: `Rate limited. Try again in ${Math.ceil(remainingMs / 1000)} seconds.` },
        { status: 429 }
      );
    }

    const pending = await getPendingMessages();
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

    // Route registration through the amended ERC-8180 BAM core: registerBlobBatch
    // carries the caller-chosen contentTag into BlobBatchRegistered as an indexed topic,
    // which the sync route filters on to recover message-in-a-blobble batches.
    // decoder=0: the BAM v1 wire format is parsed off-chain.
    // signatureRegistry=ECDSA_REGISTRY_ADDRESS: ECDSA-signed messages are verifiable
    // end-to-end through the scheme-0x01 registry (no more address(0) "unverified" path).
    if (BAM_CORE_ADDRESS === '0x0000000000000000000000000000000000000000') {
      return NextResponse.json(
        { error: 'NEXT_PUBLIC_BAM_CORE_ADDRESS is not configured' },
        { status: 500 }
      );
    }

    const registerData = encodeFunctionData({
      abi: BAM_CORE_ABI,
      functionName: 'registerBlobBatch',
      args: [
        0n, // blobIndex
        0, // startFE — full blob
        4096, // endFE — full blob
        MESSAGE_IN_A_BLOBBLE_TAG,
        zeroAddress, // decoder
        ECDSA_REGISTRY_ADDRESS,
      ],
    });

    const hash = await walletClient.sendTransaction({
      to: BAM_CORE_ADDRESS,
      data: registerData,
      blobs: blobData,
      maxFeePerBlobGas: parseGwei('30'),
      kzg,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    await createBlobble(blobbleId, pending.length);
    await updateBlobbleStatus(
      blobbleId,
      'confirmed',
      receipt.transactionHash,
      Number(receipt.blockNumber)
    );
    await markMessagesPosted(
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
