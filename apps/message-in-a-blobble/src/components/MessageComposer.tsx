'use client';

import { useState } from 'react';
import { useAccount, useSignTypedData } from 'wagmi';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import {
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  EIP712_TYPES,
  computeMessageHash,
} from 'bam-sdk/browser';
import type { Address } from 'viem';

import { MAX_MESSAGE_CHARS, MESSAGE_IN_A_BLOBBLE_TAG, SEPOLIA_CHAIN_ID } from '@/lib/constants';
import { encodeSocialContents } from '@/lib/contents-codec';
import { MESSAGES_QUERY_KEY } from '@/lib/messages';

/**
 * Per-sender next-nonce estimate. Walks the two Poster-backed sources
 * (pending + confirmed) and picks `max(nonce) + 1`. Feature 002's
 * pool enforces strict monotonicity per ERC-8180; on collision we
 * see `stale_nonce` and retry.
 */
async function nextNonceForSender(address: string): Promise<bigint> {
  const lc = address.toLowerCase();
  const [pendingRes, confirmedRes] = await Promise.all([
    fetch('/api/messages').then((r) => (r.ok ? r.json() : { pending: [] })),
    fetch('/api/confirmed-messages').then((r) => (r.ok ? r.json() : { messages: [] })),
  ]);
  const pending = (pendingRes as { pending?: Array<{ sender: string; nonce: string | number }> })
    .pending ?? [];
  const confirmed = (confirmedRes as { messages?: Array<{ sender: string; nonce: string | number }> })
    .messages ?? [];
  const parse = (v: string | number): bigint | null => {
    try {
      return BigInt(v);
    } catch {
      return null;
    }
  };
  let max = -1n;
  for (const p of pending) {
    if (p.sender.toLowerCase() !== lc) continue;
    const n = parse(p.nonce);
    if (n !== null && n > max) max = n;
  }
  for (const c of confirmed) {
    if (c.sender.toLowerCase() !== lc) continue;
    const n = parse(c.nonce);
    if (n !== null && n > max) max = n;
  }
  return max + 1n;
}

function bytesToHex(b: Uint8Array): `0x${string}` {
  return ('0x' +
    Array.from(b)
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('')) as `0x${string}`;
}

export function MessageComposer() {
  const { address, isConnected, chainId } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const queryClient = useQueryClient();
  const [content, setContent] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      if (!address || !content.trim()) throw new Error('Missing address or content');

      const trySend = async (nonce: bigint): Promise<Response> => {
        const timestamp = Math.floor(Date.now() / 1000);
        const contents = encodeSocialContents(MESSAGE_IN_A_BLOBBLE_TAG, {
          timestamp,
          content: content.trim(),
        });
        // Wallet-path ECDSA sign via EIP-712 typed data. `useSignTypedData`
        // returns the same 65-byte signature (after viem's internal
        // normalization) that `signECDSAWithKey` produces headless;
        // the SDK has a cross-runtime parity test that locks this.
        const signature = await signTypedDataAsync({
          domain: {
            name: EIP712_DOMAIN_NAME,
            version: EIP712_DOMAIN_VERSION,
            chainId: chainId ?? SEPOLIA_CHAIN_ID,
          },
          types: EIP712_TYPES,
          primaryType: 'BAMMessage',
          message: {
            sender: address as Address,
            nonce,
            contents: bytesToHex(contents),
          },
        });

        // Sanity-check the pre-batch identifier against what the
        // Poster will compute — lets us lift the messageHash into the
        // UI optimistically. Not required for correctness; the
        // Poster recomputes it on accept.
        void computeMessageHash(address as Address, nonce, contents);

        return fetch('/api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contentTag: MESSAGE_IN_A_BLOBBLE_TAG,
            message: {
              sender: address,
              nonce: nonce.toString(),
              contents: bytesToHex(contents),
              signature,
            },
          }),
        });
      };

      const MAX_STALE_RETRIES = 8;
      let nonce = await nextNonceForSender(address);
      for (let attempt = 0; attempt <= MAX_STALE_RETRIES; attempt++) {
        const res = await trySend(nonce);
        if (res.ok) return;
        const data = (await res.json()) as { reason?: string; error?: string };
        if (data.reason !== 'stale_nonce' || attempt === MAX_STALE_RETRIES) {
          throw new Error(data.reason ?? data.error ?? 'Failed to submit');
        }
        nonce = await nextNonceForSender(address);
      }
    },
    onSuccess: () => {
      setContent('');
      queryClient.invalidateQueries({ queryKey: MESSAGES_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ['posterStatus'] });
    },
  });

  const charsRemaining = MAX_MESSAGE_CHARS - [...content].length;

  if (!isConnected) {
    return (
      <div className="card mb-6 text-center text-ocean-500">
        Connect your wallet to send a message in a blobble
      </div>
    );
  }

  return (
    <div className="card mb-6">
      <label className="block text-sm font-bold text-ocean-700 mb-2">
        Your Message
      </label>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Write your message to cast into Sepolia blobspace..."
        className="w-full p-3 border border-sand-300 rounded-lg bg-sand-50 text-ocean-900
                   placeholder:text-sand-400 focus:outline-none focus:ring-2 focus:ring-ocean-400
                   resize-none h-24 font-island"
        maxLength={MAX_MESSAGE_CHARS * 4}
        disabled={mutation.isPending}
      />
      <div className="flex items-center justify-between mt-2">
        <span className={`text-sm ${charsRemaining < 0 ? 'text-red-500' : charsRemaining < 30 ? 'text-orange-500' : 'text-sand-500'}`}>
          {charsRemaining} characters remaining
        </span>
        <button
          onClick={() => mutation.mutate()}
          disabled={!content.trim() || charsRemaining < 0 || mutation.isPending}
          className="btn-primary"
        >
          {mutation.isPending ? 'Signing...' :
           mutation.isSuccess && !content.trim() ? 'Sent!' :
           'Sign & Send'}
        </button>
      </div>
      {mutation.isError && (
        <p className="text-red-500 text-sm mt-2">
          {mutation.error instanceof Error ? mutation.error.message : 'Failed to send message'}
        </p>
      )}
    </div>
  );
}
