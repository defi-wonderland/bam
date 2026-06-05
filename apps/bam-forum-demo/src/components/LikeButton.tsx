'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAccount, useSignTypedData } from 'wagmi';

import type { Bytes32 } from 'bam-sdk/browser';
import type { Address } from 'viem';

import { CONFIRMED_KEY, pendingKey } from '@/lib/queries';
import { signAndSubmit } from '@/lib/submit';

interface LikeButtonProps {
  targetMessageHash: Bytes32;
  likeCount: number;
  alreadyLikedByMe: boolean;
}

export function LikeButton({
  targetMessageHash,
  likeCount,
  alreadyLikedByMe,
}: LikeButtonProps) {
  const { address, isConnected, chainId } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async () => {
      if (!address) throw new Error('Wallet not connected');
      await signAndSubmit({
        sender: address as Address,
        chainId,
        payload: {
          kind: 0x02,
          version: 0x01,
          timestamp: BigInt(Math.floor(Date.now() / 1000)),
          targetMessageHash,
        },
        signTypedDataAsync,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CONFIRMED_KEY });
      if (address) queryClient.invalidateQueries({ queryKey: pendingKey(address.toLowerCase()) });
    },
  });

  const disabled =
    !isConnected || alreadyLikedByMe || mutation.isPending;

  return (
    <button
      type="button"
      onClick={() => mutation.mutate()}
      disabled={disabled}
      title={
        !isConnected
          ? 'Connect wallet to like'
          : alreadyLikedByMe
          ? 'Already liked'
          : 'Like'
      }
      className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium transition-colors ${
        alreadyLikedByMe
          ? 'bg-rose-100 text-rose-700'
          : 'bg-slate-100 text-slate-600 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50'
      }`}
    >
      <span>{alreadyLikedByMe ? '♥' : '♡'}</span>
      <span>{likeCount}</span>
      {mutation.isPending && <span className="text-[10px]">…</span>}
    </button>
  );
}
