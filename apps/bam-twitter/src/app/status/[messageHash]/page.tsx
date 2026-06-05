'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { use } from 'react';
import type { Bytes32 } from 'bam-sdk/browser';

import { Tweet } from '@/components/Tweet';
import type { ConfirmedRow } from '@/lib/confirmed-row';
import type { DisplayTweet } from '@/lib/timeline';

function rowToDisplayTweet(row: ConfirmedRow): DisplayTweet {
  return {
    id: row.message_id,
    sender: row.sender,
    nonce: row.nonce,
    timestamp: row.timestamp ?? 0,
    content: row.content ?? '',
    parentMessageHash: (row.parent_message_hash as Bytes32 | null) ?? null,
    status: 'posted',
    tx_hash: row.tx_hash,
    block_number: row.block_number,
  };
}

async function fetchThread(messageHash: string): Promise<{ post: DisplayTweet; replies: DisplayTweet[] }> {
  const res = await fetch(`/api/thread/${messageHash}`);
  if (!res.ok) throw new Error(`thread fetch failed: ${res.status}`);
  const data = (await res.json()) as { post: ConfirmedRow; replies: ConfirmedRow[] };
  return {
    post: rowToDisplayTweet(data.post),
    replies: data.replies.map(rowToDisplayTweet),
  };
}

export default function ThreadPage({ params }: { params: Promise<{ messageHash: string }> }) {
  const { messageHash } = use(params);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['thread', messageHash],
    queryFn: () => fetchThread(messageHash),
    retry: false,
  });

  return (
    <main className="min-h-screen">
      <header className="sticky top-0 z-10 backdrop-blur bg-white/80 border-b border-slate-200">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/" className="text-slate-500 hover:text-slate-900 text-sm">← Back</Link>
          <h1 className="text-lg font-bold text-bird-700">Thread</h1>
        </div>
      </header>
      <div className="max-w-2xl mx-auto px-4 py-6">
        {isLoading && (
          <div className="text-center text-slate-400 py-8">Loading…</div>
        )}
        {isError && (
          <div className="text-center text-slate-400 py-8">Thread not found.</div>
        )}
        {data && (
          <Tweet tweet={data.post} replies={data.replies} />
        )}
      </div>
    </main>
  );
}
