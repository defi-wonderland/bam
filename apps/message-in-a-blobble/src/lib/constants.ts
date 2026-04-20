import { keccak256, toBytes } from 'viem';

/** Legacy SocialBlobsCore deployment. Kept for reading historical `BlobRegistered` logs. */
export const SOCIAL_BLOBS_CORE_ADDRESS = '0x11a825a0774d0471292eab4706743bffcdd5d137' as const;

/**
 * Amended `BlobAuthenticatedMessagingCore` (ERC-8180) deployment.
 *
 * Set via `NEXT_PUBLIC_BAM_CORE_ADDRESS`. Falls back to the zero address so misconfig is
 * a loud error at first send rather than silently targeting the legacy contract.
 */
export const BAM_CORE_ADDRESS = (process.env.NEXT_PUBLIC_BAM_CORE_ADDRESS ||
  '0x0000000000000000000000000000000000000000') as `0x${string}`;

/**
 * Protocol/content identifier emitted in the BAM core events. Indexers — including this
 * app's own sync route — filter `BlobBatchRegistered` logs by this tag to recover the
 * batches `message-in-a-blobble` registered (as distinct from any other protocol sharing
 * the BAM core deployment).
 */
export const MESSAGE_IN_A_BLOBBLE_TAG = keccak256(toBytes('message-in-a-blobble.v1'));

export const SEPOLIA_CHAIN_ID = 11155111;
export const MAX_MESSAGE_CHARS = 280;
