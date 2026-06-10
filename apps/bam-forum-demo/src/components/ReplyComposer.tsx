'use client';

import { useState } from 'react';
import { useAccount, useSignTypedData } from 'wagmi';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Address } from 'viem';

import type { Bytes32 } from 'bam-sdk/browser';

import { MAX_REPLY_CHARS } from '@/lib/constants';
import { CONFIRMED_KEY, pendingKey } from '@/lib/queries';
import { signAndSubmit } from '@/lib/submit';

interface ReplyComposerProps {
  parentMessageHash: Bytes32;
}

export function ReplyComposer({ parentMessageHash }: ReplyComposerProps) {
  const { address, isConnected, chainId } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const queryClient = useQueryClient();

  const [body, setBody] = useState('');
  const overflow = [...body].length > MAX_REPLY_CHARS;

  const mutation = useMutation({
    mutationFn: async () => {
      if (!address) throw new Error('Wallet not connected');
      await signAndSubmit({
        sender: address as Address,
        chainId,
        payload: {
          kind: 0x01,
          version: 0x01,
          timestamp: BigInt(Math.floor(Date.now() / 1000)),
          parentMessageHash,
          body: body.trim(),
        },
        signTypedDataAsync,
      });
    },
    onSuccess: () => {
      setBody('');
      queryClient.invalidateQueries({ queryKey: CONFIRMED_KEY });
      if (address) queryClient.invalidateQueries({ queryKey: pendingKey(address.toLowerCase()) });
    },
  });

  if (!isConnected) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
        Connect your wallet to reply.
      </div>
    );
  }

  const valid = body.trim().length > 0 && !overflow;

  return (
    <div className="rounded-md border border-slate-200 bg-white p-3">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        placeholder="Write a reply…"
        disabled={mutation.isPending}
        className="w-full resize-none rounded-md border border-slate-200 p-2 text-sm text-slate-900 focus:border-blue-400 focus:outline-none"
      />
      {mutation.isError && (
        <div className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
          {mutation.error instanceof Error ? mutation.error.message : 'Submit failed'}
        </div>
      )}
      <div className="mt-2 flex items-center justify-between">
        <span
          className={`text-xs ${
            overflow ? 'text-red-600' : 'text-slate-400'
          }`}
        >
          {[...body].length}/{MAX_REPLY_CHARS}
        </span>
        <button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={!valid || mutation.isPending}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {mutation.isPending ? 'Replying…' : 'Reply'}
        </button>
      </div>
    </div>
  );
}
