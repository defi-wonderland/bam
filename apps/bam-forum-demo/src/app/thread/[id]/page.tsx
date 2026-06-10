'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { notFound, useParams } from 'next/navigation';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount } from 'wagmi';

import { ProofDrawer } from '@/components/ProofDrawer';
import { ReplyComposer } from '@/components/ReplyComposer';
import { ReplyItem } from '@/components/ReplyItem';
import { ThreadHeader } from '@/components/ThreadHeader';
import type { ForumMessage } from '@/lib/forum-row';
import { useConfirmed, usePending } from '@/lib/queries';
import { getThread, indexLikesBySender } from '@/lib/threading';

export default function ThreadPage() {
  const params = useParams<{ id: string }>();
  const rawId = params?.id ?? '';
  const messageHash = rawId.startsWith('0x') ? rawId.toLowerCase() : `0x${rawId.toLowerCase()}`;

  const { address } = useAccount();
  const me = address?.toLowerCase() ?? null;
  const { data: confirmed, isLoading: confirmedLoading } = useConfirmed();
  const { data: pending, isLoading: pendingLoading } = usePending(me ?? undefined);

  const [proofHash, setProofHash] = useState<string | null>(null);

  const { thread, likesByTarget } = useMemo(() => {
    const rows: ForumMessage[] = [
      ...((confirmed?.messages ?? []) as ForumMessage[]),
      ...((pending?.messages ?? []) as ForumMessage[]),
    ];
    const seen = new Set<string>();
    const deduped: ForumMessage[] = [];
    for (const m of rows) {
      const key = m.messageHash.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(m);
    }
    return {
      thread: getThread(deduped, messageHash as `0x${string}`),
      likesByTarget: indexLikesBySender(deduped),
    };
  }, [confirmed, pending, messageHash]);

  const likeCountFor = (hash: string) =>
    likesByTarget.get(hash.toLowerCase())?.size ?? 0;
  const alreadyLikedByMeFor = (hash: string) => {
    if (!me) return false;
    return likesByTarget.get(hash.toLowerCase())?.has(me) ?? false;
  };

  if ((confirmedLoading || (!!me && pendingLoading)) && !thread) {
    return (
      <div className="min-h-screen bg-slate-100">
        <nav className="border-b border-slate-200 bg-white shadow-sm">
          <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
            <span className="text-base font-bold text-slate-900">BAM Forum</span>
            <ConnectButton />
          </div>
        </nav>
        <div className="mx-auto max-w-4xl px-4 py-8 text-center text-sm text-slate-400">
          Loading thread…
        </div>
      </div>
    );
  }

  if (!thread) {
    notFound();
  }

  return (
    <div className="min-h-screen bg-slate-100">
      <nav className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
          <span className="text-base font-bold text-slate-900">BAM Forum</span>
          <ConnectButton />
        </div>
      </nav>

      <div className="mx-auto max-w-4xl px-4 py-6">
        <nav className="mb-4 text-sm text-slate-500">
          <Link href="/" className="text-blue-600 hover:underline">
            General Discussion
          </Link>
          <span className="mx-2">›</span>
          <span className="truncate text-slate-700">{thread.post.title}</span>
        </nav>

        <ThreadHeader
          post={thread.post}
          likeCount={thread.likeCount}
          alreadyLikedByMe={me ? thread.alreadyLikedBy(me) : false}
          onOpenProof={setProofHash}
        />

        <div className="mb-4">
          <ReplyComposer parentMessageHash={thread.post.messageHash} />
        </div>

        {thread.replies.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">
            No replies yet. Be the first.
          </p>
        ) : (
          <ol className="space-y-3">
            {thread.replies.map((r) => (
              <ReplyItem
                key={r.messageHash}
                reply={r}
                likeCount={likeCountFor(r.messageHash)}
                alreadyLikedByMe={alreadyLikedByMeFor(r.messageHash)}
                onOpenProof={setProofHash}
              />
            ))}
          </ol>
        )}
      </div>

      <ProofDrawer messageHash={proofHash} onClose={() => setProofHash(null)} />
    </div>
  );
}
