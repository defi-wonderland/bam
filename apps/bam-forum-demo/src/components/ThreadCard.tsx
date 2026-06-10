'use client';

import Link from 'next/link';

import type { PostRow } from '@/lib/forum-row';
import { relativeTime } from '@/lib/time';

import { AddressDisplay } from './AddressDisplay';
import { StatusBadge } from './StatusBadge';

interface ThreadCardProps {
  post: PostRow;
  replyCount: number;
  likeCount: number;
  onOpenProof: (messageHash: string) => void;
}

export function ThreadCard({
  post,
  replyCount,
  likeCount,
  onOpenProof,
}: ThreadCardProps) {
  return (
    <li className="border-b border-slate-200 py-5 last:border-b-0">
      <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
        {post.tag.length > 0 && (
          <span className="rounded-full bg-blue-50 px-2 py-0.5 font-semibold text-blue-700 dark:bg-blue-950 dark:text-blue-300">
            {post.tag}
          </span>
        )}
        <AddressDisplay address={post.sender} ensName={post.senderEns} />
        <span>·</span>
        <span>{relativeTime(post.timestamp)}</span>
        <span className="ml-auto">
          <StatusBadge
            status={post.status}
            onClick={
              post.status === 'proven'
                ? () => onOpenProof(post.messageHash)
                : undefined
            }
          />
        </span>
      </div>
      <Link
        href={`/thread/${post.messageHash}`}
        className="block font-semibold text-slate-900 hover:text-blue-600 dark:text-slate-100 dark:hover:text-blue-400"
      >
        {post.title}
      </Link>
      <p className="mt-1 mb-2 line-clamp-2 text-sm text-slate-500">{post.body}</p>
      <div className="text-xs text-slate-400">
        💬 {replyCount} {replyCount === 1 ? 'reply' : 'replies'} · ♡ {likeCount}{' '}
        <span className="text-[10px]">(reader-counted)</span>
      </div>
    </li>
  );
}
