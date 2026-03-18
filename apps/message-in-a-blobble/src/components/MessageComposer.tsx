'use client';

import { useState } from 'react';
import { useAccount, useSignMessage } from 'wagmi';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { computeMessageHash } from 'bam-sdk/browser';
import { MAX_MESSAGE_CHARS } from '@/lib/constants';

async function fetchMessages(): Promise<{ author: string; [key: string]: unknown }[]> {
  const res = await fetch('/api/messages');
  const data = await res.json();
  return data.messages || [];
}

export function MessageComposer() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const queryClient = useQueryClient();
  const [content, setContent] = useState('');

  const { data: allMessages = [] } = useQuery({
    queryKey: ['messages'],
    queryFn: fetchMessages,
  });

  const mutation = useMutation({
    mutationFn: async () => {
      if (!address || !content.trim()) throw new Error('Missing address or content');

      const timestamp = Math.floor(Date.now() / 1000);
      const existingFromAuthor = allMessages.filter(
        (m) => m.author.toLowerCase() === address.toLowerCase()
      );
      const nonce = existingFromAuthor.length;

      const msg = { author: address, timestamp, nonce, content: content.trim() };
      const messageHash = computeMessageHash(msg);

      const signature = await signMessageAsync({
        message: { raw: messageHash },
      });

      const res = await fetch('/api/messages', {
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

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to submit');
      }
    },
    onSuccess: () => {
      setContent('');
      queryClient.invalidateQueries({ queryKey: ['messages'] });
      queryClient.invalidateQueries({ queryKey: ['pendingCount'] });
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
