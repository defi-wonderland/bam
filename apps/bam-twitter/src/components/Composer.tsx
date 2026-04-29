'use client';

import { useState } from 'react';
import { useAccount, useSignTypedData } from 'wagmi';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import {
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  EIP712_TYPES,
  computeMessageHash,
  type Bytes32,
} from 'bam-sdk/browser';
import type { Address } from 'viem';

import { MAX_POST_CHARS, SEPOLIA_CHAIN_ID, TWITTER_TAG } from '@/lib/constants';
import { encodeTwitterContents, type TwitterMessage } from '@/lib/contents-codec';
import { TWEETS_QUERY_KEY } from '@/lib/timeline';

/**
 * Per-sender next-nonce estimate. Walks the two Poster-backed sources
 * (pending + confirmed) and picks `max(nonce) + 1`. The Poster's pool
 * enforces strict monotonicity per ERC-8180; on collision the
 * mutation retries up to MAX_STALE_RETRIES.
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

interface ComposerProps {
  /** Set to a parent messageHash to switch into reply mode. */
  replyTo?: Bytes32;
  onSent?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
}

export function Composer({ replyTo, onSent, placeholder, autoFocus }: ComposerProps) {
  const { address, isConnected, chainId } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const queryClient = useQueryClient();
  const [content, setContent] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      if (!address || !content.trim()) throw new Error('Missing address or content');

      const trySend = async (nonce: bigint): Promise<Response> => {
        const timestamp = Math.floor(Date.now() / 1000);
        const app: TwitterMessage =
          replyTo !== undefined
            ? {
                kind: 'reply',
                timestamp,
                parentMessageHash: replyTo,
                content: content.trim(),
              }
            : { kind: 'post', timestamp, content: content.trim() };
        const contents = encodeTwitterContents(TWITTER_TAG, app);

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

        // Optimistic preview: compute the same messageHash the Poster
        // will compute on accept so the UI could surface it without
        // waiting for the round-trip.
        void computeMessageHash(address as Address, nonce, contents);

        return fetch('/api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contentTag: TWITTER_TAG,
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
      queryClient.invalidateQueries({ queryKey: TWEETS_QUERY_KEY });
      onSent?.();
    },
  });

  const charsRemaining = MAX_POST_CHARS - [...content].length;

  if (!isConnected) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-4 text-center text-slate-500">
        Connect your wallet to {replyTo ? 'reply' : 'post'}.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={placeholder ?? (replyTo ? 'Post your reply' : "What's happening?")}
        className="w-full p-3 border border-slate-200 rounded-lg bg-white text-slate-900
                   placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-bird-400
                   resize-none h-20"
        maxLength={MAX_POST_CHARS * 4}
        disabled={mutation.isPending}
        autoFocus={autoFocus}
      />
      <div className="flex items-center justify-between mt-2">
        <span
          className={`text-sm ${
            charsRemaining < 0
              ? 'text-red-500'
              : charsRemaining < 30
              ? 'text-orange-500'
              : 'text-slate-400'
          }`}
        >
          {charsRemaining}
        </span>
        <button
          onClick={() => mutation.mutate()}
          disabled={!content.trim() || charsRemaining < 0 || mutation.isPending}
          className="bg-bird-600 hover:bg-bird-700 text-white font-bold py-2 px-5 rounded-full
                     transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {mutation.isPending
            ? replyTo
              ? 'Replying…'
              : 'Posting…'
            : replyTo
            ? 'Reply'
            : 'Post'}
        </button>
      </div>
      {mutation.isError && (
        <p className="text-red-500 text-sm mt-2">
          {mutation.error instanceof Error ? mutation.error.message : 'Failed to send'}
        </p>
      )}
    </div>
  );
}
