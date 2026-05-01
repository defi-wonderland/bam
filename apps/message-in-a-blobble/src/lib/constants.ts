/**
 * ERC-8180 `BlobAuthenticatedMessagingCore` deployment. Set via
 * `NEXT_PUBLIC_BAM_CORE_ADDRESS`. Falls back to the zero address so
 * misconfiguration fails loudly instead of silently skipping event
 * queries.
 */
export const BAM_CORE_ADDRESS = (process.env.NEXT_PUBLIC_BAM_CORE_ADDRESS ||
  '0x0000000000000000000000000000000000000000') as `0x${string}`;

/**
 * Protocol/content identifier emitted in the BAM core events. Indexers — including this
 * app's own sync route — filter `BlobBatchRegistered` logs by this tag to recover the
 * batches `message-in-a-blobble` registered (as distinct from any other protocol sharing
 * the BAM core deployment).
 *
 * Precomputed `keccak256(utf8("message-in-a-blobble.v1"))` — hardcoded as a literal so
 * this module stays free of `viem` and doesn't leak chain utilities into the client
 * bundle via shared imports (e.g. `MAX_MESSAGE_CHARS`).
 */
export const MESSAGE_IN_A_BLOBBLE_TAG =
  '0x323eee4675c068805a324c1a3a36805d446179434138f2f0872ac3f81b2e6591' as const;

export const SEPOLIA_CHAIN_ID = 11155111;
export const MAX_MESSAGE_CHARS = 280;

/**
 * Sepolia ECDSA signature registry (ERC-8180 scheme `0x01`). Passed as the
 * `signatureRegistry` argument on `registerBlobBatch` so indexers / exposers
 * that route via `SignatureRegistryDispatcher` can verify this app's
 * ECDSA-signed messages against a real registry rather than treating them as
 * unregistered (`address(0)`).
 */
export const ECDSA_REGISTRY_ADDRESS =
  '0xF4Ce909305a112C2CBEC6b339a42f34bA8bf3381' as const;
