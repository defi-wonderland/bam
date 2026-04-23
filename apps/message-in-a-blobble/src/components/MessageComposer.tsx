'use client';

import { useState } from 'react';
import { useAccount, useSignMessage } from 'wagmi';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { computeMessageHash } from 'bam-sdk/browser';
import { MAX_MESSAGE_CHARS } from '@/lib/constants';

/**
 * Per-author next-nonce estimate. Walks the two sources the demo has
 * visibility into (Poster pending + demo-DB confirmed) and picks
 * `max(nonce) + 1`. The Poster enforces strict monotonicity per
 * ERC-8180, so if our guess collides with an in-flight submit we get
 * `stale_nonce` back and retry with nonce+1.
 */
async function nextNonceForAuthor(address: string): Promise<number> {
  const lc = address.toLowerCase();
  const [pendingRes, confirmedRes] = await Promise.all([
    fetch('/api/messages').then((r) => (r.ok ? r.json() : { pending: [] })),
    fetch('/api/confirmed-messages').then((r) => (r.ok ? r.json() : { messages: [] })),
  ]);
  const pending = (pendingRes as { pending?: Array<{ author: string; nonce: string | number }> })
    .pending ?? [];
  const confirmed = (confirmedRes as { messages?: Array<{ author: string; nonce: number }> })
    .messages ?? [];
  let max = -1;
  for (const p of pending) {
    if (p.author.toLowerCase() !== lc) continue;
    const n = typeof p.nonce === 'string' ? Number(p.nonce) : p.nonce;
    if (Number.isFinite(n) && n > max) max = n;
  }
  for (const c of confirmed) {
    if (c.author.toLowerCase() !== lc) continue;
    if (c.nonce > max) max = c.nonce;
  }
  return max + 1;
}

export function MessageComposer() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const queryClient = useQueryClient();
  const [content, setContent] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      if (!address || !content.trim()) throw new Error('Missing address or content');

      const timestamp = Math.floor(Date.now() / 1000);
      // Try a reasonable next-nonce; on `stale_nonce` retry once
      // with +1 to cover an in-flight submission we didn't see.
      const trySend = async (nonce: number): Promise<Response> => {
        const msg = { author: address, timestamp, nonce, content: content.trim() };
        const messageHash = computeMessageHash(msg);
        const signature = await signMessageAsync({ message: { raw: messageHash } });
        return fetch('/api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            author: address,
            timestamp,
            nonce,
            content: content.trim(),
            signature,
          }),
        });
      };

      const initial = await nextNonceForAuthor(address);
      let res = await trySend(initial);
      if (!res.ok) {
        const data = (await res.json()) as { reason?: string; error?: string };
        if (data.reason === 'stale_nonce') {
          res = await trySend(initial + 1);
        }
        if (!res.ok) {
          const err = (await res.json()) as { reason?: string; error?: string };
          throw new Error(err.reason ?? err.error ?? 'Failed to submit');
        }
      }
    },
    onSuccess: () => {
      setContent('');
      queryClient.invalidateQueries({ queryKey: ['messages'] });
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
