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
      ...((confirmed?.messages ?? []) as ForumMessage[]),
      ...((pending?.messages ?? []) as ForumMessage[]),
    ];
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
    <div className="min-h-screen bg-slate-100">
      <nav className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
          <span className="text-base font-bold text-slate-900">BAM Forum</span>
          <ConnectButton />
        </div>
      </nav>

      <div className="mx-auto max-w-4xl px-4 py-6">
        <div className="mb-4 flex items-end justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">General Discussion</h1>
            <p className="mt-0.5 text-sm text-slate-500">Decentralised threads, backed by blobs.</p>
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

        <ProofPanel />

        {confirmedError && (
          <div className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            Couldn&apos;t load confirmed messages —{' '}
            {confirmedError instanceof Error ? confirmedError.message : 'unknown error'}.
          </div>
        )}

        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase tracking-wide text-slate-400">
                <th className="px-4 py-2.5 text-left">Topic</th>
                <th className="w-20 px-4 py-2.5 text-center">Replies</th>
                <th className="w-28 px-4 py-2.5 text-right">Activity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {confirmedLoading && threads.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-sm text-slate-400">
                    Loading threads…
                  </td>
                </tr>
              )}
              {!confirmedLoading && !confirmedError && threads.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-sm text-slate-400">
                    No threads yet. Be the first to post.
                  </td>
                </tr>
              )}
              {threads.map((t) => (
                <ThreadCard
                  key={t.post.messageHash}
                  post={t.post}
                  replyCount={t.replies.length}
                  likeCount={t.likeCount}
                  onOpenProof={setProofHash}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Composer open={composerOpen} onClose={() => setComposerOpen(false)} />
      <ProofDrawer messageHash={proofHash} onClose={() => setProofHash(null)} />
    </div>
  );
}
