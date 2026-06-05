'use client';

import { useMemo, useState } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount } from 'wagmi';

import { Composer } from '@/components/Composer';
import { ProofDrawer } from '@/components/ProofDrawer';
import { ProofPanel } from '@/components/ProofPanel';
import { ThreadCard } from '@/components/ThreadCard';
import type { ForumMessage } from '@/lib/forum-row';
import { useConfirmed, usePending } from '@/lib/queries';
import { buildThreads } from '@/lib/threading';

export default function Home() {
  const { address } = useAccount();
  const { data: confirmed, isLoading: confirmedLoading, error: confirmedError } = useConfirmed();
  const { data: pending } = usePending(address?.toLowerCase());

  const [composerOpen, setComposerOpen] = useState(false);
  const [proofHash, setProofHash] = useState<string | null>(null);

  const threads = useMemo(() => {
    const all: ForumMessage[] = [
      ...((pending?.messages ?? []) as ForumMessage[]),
      ...((confirmed?.messages ?? []) as ForumMessage[]),
    ];
    // Dedup by messageHash — a row briefly appears in both feeds during
    // the poster→reader handoff.
    const seen = new Set<string>();
    const deduped: ForumMessage[] = [];
    for (const m of all) {
      const key = m.messageHash.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(m);
    }
    return buildThreads(deduped)
      .slice()
      .sort((a, b) => b.post.timestamp - a.post.timestamp);
  }, [confirmed, pending]);

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-6 flex items-baseline justify-between border-b border-slate-200 pb-4 dark:border-slate-700">
        <span className="text-lg font-bold">BAM Forum</span>
        <ConnectButton />
      </header>

      <div className="mb-6 flex items-end justify-between gap-3">
        <div>
          <h1 className="mb-1 text-2xl font-bold">General Discussion</h1>
          <p className="text-sm text-slate-500">
            Decentralised threads, backed by blobs.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setComposerOpen(true)}
          disabled={!address}
          title={address ? 'Compose a new thread' : 'Connect wallet to compose'}
          className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          New thread
        </button>
      </div>

      <div className="mb-4">
        <ProofPanel />
      </div>

      {confirmedLoading && (
        <p className="py-8 text-center text-sm text-slate-500">Loading threads…</p>
      )}
      {confirmedError && (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          Couldn&apos;t load confirmed messages —{' '}
          {confirmedError instanceof Error ? confirmedError.message : 'unknown error'}.
        </div>
      )}
      {!confirmedLoading && !confirmedError && threads.length === 0 && (
        <p className="py-8 text-center text-sm text-slate-500">
          No threads yet. Be the first to post.
        </p>
      )}

      <ul className="divide-y divide-slate-200 dark:divide-slate-700">
        {threads.map((t) => (
          <ThreadCard
            key={t.post.messageHash}
            post={t.post}
            replyCount={t.replies.length}
            likeCount={t.likeCount}
            onOpenProof={setProofHash}
          />
        ))}
      </ul>

      <Composer open={composerOpen} onClose={() => setComposerOpen(false)} />
      <ProofDrawer messageHash={proofHash} onClose={() => setProofHash(null)} />
    </div>
  );
}
