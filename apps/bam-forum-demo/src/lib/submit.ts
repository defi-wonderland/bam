/**
 * Shared sign-then-submit helper for the three message kinds the forum
 * supports (post, reply, like). Used by `Composer`, `ReplyComposer`,
 * and `LikeButton`.
 *
 * Mirrors `apps/bam-twitter/src/components/Composer.tsx`'s flow:
 *   1. Fetch next nonce via `/api/next-nonce?sender=…`
 *   2. Encode payload via `bam-sdk/forum`
 *   3. EIP-712 sign typed-data (caller supplies wagmi's
 *      `signTypedDataAsync` so this stays framework-agnostic)
 *   4. POST `/api/messages` envelope
 *   5. On `stale_nonce`, re-fetch nonce and retry. Cap at 8 attempts.
 *
 * Returns the computed `messageHash` + envelope `nonce` so callers can
 * synthesize an optimistic Pending row before the next `/api/pending`
 * tick.
 */

import {
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  EIP712_TYPES,
  bytesToHex,
  computeMessageHash,
  type Address,
  type Bytes32,
} from 'bam-sdk/browser';
import { encodeForumContents, type ForumPayload } from 'bam-sdk/forum';

import { FORUM_TAG, SEPOLIA_CHAIN_ID } from './constants';

/**
 * Signature of wagmi's `useSignTypedData().signTypedDataAsync`. Kept
 * loose so we don't need to import the wagmi action's generic types
 * into this server-friendly module — callers pass the hook return.
 */
export type SignTypedDataAsync = (args: {
  domain: { name: string; version: string; chainId: number };
  types: typeof EIP712_TYPES;
  primaryType: 'BAMMessage';
  message: {
    sender: Address;
    contentTag: Bytes32;
    nonce: bigint;
    contents: `0x${string}`;
  };
}) => Promise<`0x${string}`>;

export interface SignAndSubmitArgs {
  sender: Address;
  chainId?: number;
  payload: ForumPayload;
  signTypedDataAsync: SignTypedDataAsync;
}

export interface SubmitResult {
  messageHash: Bytes32;
  nonce: bigint;
  /** The encoded payload bytes — handy for an optimistic Pending row. */
  contents: Uint8Array;
}

const MAX_STALE_RETRIES = 8;

async function fetchNextNonce(sender: string): Promise<bigint> {
  const res = await fetch(`/api/next-nonce?sender=${encodeURIComponent(sender)}`);
  if (!res.ok) {
    throw new Error(`next-nonce lookup failed: ${res.status}`);
  }
  const data = (await res.json()) as { nextNonce?: string };
  if (typeof data.nextNonce !== 'string') {
    throw new Error('next-nonce response missing nextNonce');
  }
  return BigInt(data.nextNonce);
}

export async function signAndSubmit(args: SignAndSubmitArgs): Promise<SubmitResult> {
  const { sender, chainId, payload, signTypedDataAsync } = args;
  const contents = encodeForumContents(payload);
  const contentsHex = bytesToHex(contents) as `0x${string}`;

  let nonce = await fetchNextNonce(sender);

  for (let attempt = 0; attempt <= MAX_STALE_RETRIES; attempt++) {
    const signature = await signTypedDataAsync({
      domain: {
        name: EIP712_DOMAIN_NAME,
        version: EIP712_DOMAIN_VERSION,
        chainId: chainId ?? SEPOLIA_CHAIN_ID,
      },
      types: EIP712_TYPES,
      primaryType: 'BAMMessage',
      message: {
        sender,
        contentTag: FORUM_TAG,
        nonce,
        contents: contentsHex,
      },
    });

    const res = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          sender,
          nonce: nonce.toString(),
          contents: contentsHex,
          signature,
        },
      }),
    });

    if (res.ok) {
      const messageHash = computeMessageHash(sender, FORUM_TAG, nonce, contents);
      return { messageHash, nonce, contents };
    }

    const data = (await res.json().catch(() => ({}))) as {
      reason?: string;
      error?: string;
    };

    if (data.reason !== 'stale_nonce' || attempt === MAX_STALE_RETRIES) {
      throw new Error(data.reason ?? data.error ?? `submit failed (HTTP ${res.status})`);
    }

    // Stale nonce: refresh and retry.
    nonce = await fetchNextNonce(sender);
  }

  // Unreachable — the loop above either returns or throws.
  throw new Error('signAndSubmit: exhausted retries');
}
