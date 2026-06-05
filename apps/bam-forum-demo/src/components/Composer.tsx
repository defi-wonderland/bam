'use client';

import { useState } from 'react';
import { useAccount, useSignTypedData } from 'wagmi';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Address } from 'viem';

import {
  MAX_BODY_CHARS,
  MAX_TAG_BYTES,
  MAX_TITLE_CHARS,
} from '@/lib/constants';
import { CONFIRMED_KEY, pendingKey } from '@/lib/queries';
import { signAndSubmit } from '@/lib/submit';

interface ComposerProps {
  open: boolean;
  onClose: () => void;
}

const textEncoder = new TextEncoder();

export function Composer({ open, onClose }: ComposerProps) {
  const { address, isConnected, chainId } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const queryClient = useQueryClient();

  const [title, setTitle] = useState('');
  const [tag, setTag] = useState('');
  const [body, setBody] = useState('');

  const tagBytes = textEncoder.encode(tag);
  const tagOverflow = tagBytes.byteLength > MAX_TAG_BYTES;
  const titleOverflow = [...title].length > MAX_TITLE_CHARS;
  const bodyOverflow = [...body].length > MAX_BODY_CHARS;
  const valid =
    isConnected &&
    title.trim().length > 0 &&
    body.trim().length > 0 &&
    !tagOverflow &&
    !titleOverflow &&
    !bodyOverflow;

  const mutation = useMutation({
    mutationFn: async () => {
      if (!address) throw new Error('Wallet not connected');
      await signAndSubmit({
        sender: address as Address,
        chainId,
        payload: {
          kind: 0x00,
          version: 0x02,
          timestamp: BigInt(Math.floor(Date.now() / 1000)),
          tag: tagBytes,
          title: title.trim(),
          body: body.trim(),
        },
        signTypedDataAsync,
      });
    },
    onSuccess: () => {
      setTitle('');
      setTag('');
      setBody('');
      queryClient.invalidateQueries({ queryKey: CONFIRMED_KEY });
      if (address) queryClient.invalidateQueries({ queryKey: pendingKey(address.toLowerCase()) });
      onClose();
    },
  });

  if (!open) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-slate-900/40"
        onClick={() => !mutation.isPending && onClose()}
        aria-hidden="true"
      />
      <div className="fixed left-1/2 top-20 z-50 w-[92vw] max-w-lg -translate-x-1/2 rounded-xl border border-slate-200 bg-white p-5 shadow-xl">
        <header className="flex items-baseline justify-between pb-3">
          <h2 className="text-base font-semibold text-slate-900">New thread</h2>
          <button
            type="button"
            onClick={() => !mutation.isPending && onClose()}
            disabled={mutation.isPending}
            className="text-sm text-slate-400 hover:text-slate-700 disabled:opacity-50"
          >
            Close
          </button>
        </header>

        <div className="space-y-3">
          <div>
            <label className="block text-xs text-slate-500">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={MAX_TITLE_CHARS * 2}
              placeholder="Subject of this thread"
              className="mt-1 w-full rounded-md border border-slate-300 p-2 text-sm text-slate-900 focus:border-blue-400 focus:outline-none"
              disabled={mutation.isPending}
            />
            {titleOverflow && (
              <p className="mt-1 text-xs text-red-600">
                Title is {[...title].length}/{MAX_TITLE_CHARS} characters
              </p>
            )}
          </div>

          <div>
            <label className="block text-xs text-slate-500">
              Tag (optional, max {MAX_TAG_BYTES} bytes UTF-8)
            </label>
            <input
              type="text"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              placeholder="e.g. Protocol, Dev, General"
              className="mt-1 w-full rounded-md border border-slate-300 p-2 text-sm text-slate-900 focus:border-blue-400 focus:outline-none"
              disabled={mutation.isPending}
            />
            <p className="mt-1 text-xs text-slate-400">
              {tagBytes.byteLength}/{MAX_TAG_BYTES} bytes
              {tagOverflow && <span className="ml-1 text-red-600">— exceeds limit</span>}
            </p>
          </div>

          <div>
            <label className="block text-xs text-slate-500">Body</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={MAX_BODY_CHARS * 2}
              rows={6}
              placeholder="What's on your mind?"
              className="mt-1 w-full resize-none rounded-md border border-slate-300 p-2 text-sm text-slate-900 focus:border-blue-400 focus:outline-none"
              disabled={mutation.isPending}
            />
            <p
              className={`mt-1 text-xs ${
                bodyOverflow ? 'text-red-600' : 'text-slate-400'
              }`}
            >
              {[...body].length}/{MAX_BODY_CHARS}
            </p>
          </div>

          {mutation.isError && (
            <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
              {mutation.error instanceof Error
                ? mutation.error.message
                : 'Submit failed'}
            </div>
          )}

          {!isConnected && (
            <p className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
              Connect your wallet to post.
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => mutation.mutate()}
              disabled={!valid || mutation.isPending}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {mutation.isPending ? 'Signing & posting…' : 'Post thread'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
