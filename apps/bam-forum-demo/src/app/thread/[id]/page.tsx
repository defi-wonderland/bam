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
  const { data: pending } = usePending(me ?? undefined);

  const [proofHash, setProofHash] = useState<string | null>(null);

  const { thread, likesByTarget } = useMemo(() => {
    const rows: ForumMessage[] = [
      ...((pending?.messages ?? []) as ForumMessage[]),
      ...((confirmed?.messages ?? []) as ForumMessage[]),
    ];
    // Dedup by messageHash — pending and confirmed overlap during handoff.
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

  if (confirmedLoading && !thread) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <header className="mb-6 flex items-baseline justify-between border-b border-slate-200 pb-4 dark:border-slate-700">
          <span className="text-lg font-bold">BAM Forum</span>
          <ConnectButton />
        </header>
        <p className="py-8 text-center text-sm text-slate-500">Loading thread…</p>
      </div>
    );
  }

  if (!thread) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-6 flex items-baseline justify-between border-b border-slate-200 pb-4 dark:border-slate-700">
        <span className="text-lg font-bold">BAM Forum</span>
        <ConnectButton />
      </header>

      <div className="mb-4 text-sm text-slate-500">
        <Link href="/" className="text-blue-600 hover:underline dark:text-blue-400">
          General Discussion
        </Link>
        <span className="mx-2">›</span>
        <span>Thread</span>
      </div>

      <ThreadHeader
        post={thread.post}
        likeCount={thread.likeCount}
        alreadyLikedByMe={me ? thread.alreadyLikedBy(me) : false}
        onOpenProof={setProofHash}
      />

      <div className="mb-5">
        <ReplyComposer parentMessageHash={thread.post.messageHash} />
      </div>

      {thread.replies.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-400">
          No replies yet. Be the first.
        </p>
      ) : (
        <ol className="space-y-5">
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

      <ProofDrawer messageHash={proofHash} onClose={() => setProofHash(null)} />
    </div>
  );
}
