'use client';

import { useState } from 'react';
import { useAccount, useSignMessage } from 'wagmi';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { computeMessageHash } from 'bam-sdk/browser';
import { MAX_MESSAGE_CHARS } from '@/lib/constants';

/**
 * Per-author next-nonce estimate. Walks the two sources the demo has
 * visibility into (Poster pending + Poster-backed confirmed) and
 * picks `max(nonce) + 1`. The Poster enforces strict monotonicity
 * per ERC-8180, so if our guess collides with an in-flight submit we
 * get `stale_nonce` back and retry with nonce+1.
 *
 * Arithmetic runs in BigInt to support uint64 nonces — v1 wire is
 * uint16 and well within Number range, but NEXT_SPEC widens to uint64
 * and the Poster already returns decimal strings.
 */
async function nextNonceForAuthor(address: string): Promise<bigint> {
  const lc = address.toLowerCase();
  const [pendingRes, confirmedRes] = await Promise.all([
    fetch('/api/messages').then((r) => (r.ok ? r.json() : { pending: [] })),
    fetch('/api/confirmed-messages').then((r) => (r.ok ? r.json() : { messages: [] })),
  ]);
  const pending = (pendingRes as { pending?: Array<{ author: string; nonce: string | number }> })
    .pending ?? [];
  const confirmed = (confirmedRes as { messages?: Array<{ author: string; nonce: string | number }> })
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
    if (p.author.toLowerCase() !== lc) continue;
    const n = parse(p.nonce);
    if (n !== null && n > max) max = n;
  }
  for (const c of confirmed) {
    if (c.author.toLowerCase() !== lc) continue;
    const n = parse(c.nonce);
    if (n !== null && n > max) max = n;
  }
  return max + 1n;
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
      // v1 wire encodes nonce as uint16 — `bam-sdk`'s computeMessageHash
      // packs it via `DataView.setUint16`, which silently truncates
      // anything ≥ 65536 and produces a wrong hash/signature. We compute
      // next-nonce in BigInt for NEXT_SPEC forward-compat, then enforce
      // the v1 ceiling at the network boundary.
      const toWire = (n: bigint): number => {
        if (n < 0n || n > 0xffffn) {
          throw new Error(
            `nonce ${n} exceeds v1 wire uint16 range — demo cannot submit further messages without a protocol upgrade`
          );
        }
        return Number(n);
      };
      // Try a reasonable next-nonce; on `stale_nonce` retry once
      // with +1 to cover an in-flight submission we didn't see.
      const trySend = async (nonce: bigint): Promise<Response> => {
        const wire = toWire(nonce);
        const msg = { author: address, timestamp, nonce: wire, content: content.trim() };
        const messageHash = computeMessageHash(msg);
        const signature = await signMessageAsync({ message: { raw: messageHash } });
        return fetch('/api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            author: address,
            timestamp,
            nonce: wire,
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
          res = await trySend(initial + 1n);
          if (!res.ok) {
            const err = (await res.json()) as { reason?: string; error?: string };
            throw new Error(err.reason ?? err.error ?? 'Failed to submit');
          }
        } else {
          throw new Error(data.reason ?? data.error ?? 'Failed to submit');
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
