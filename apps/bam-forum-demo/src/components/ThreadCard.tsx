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

export function ThreadCard({ post, replyCount, likeCount, onOpenProof }: ThreadCardProps) {
  return (
    <tr className="group hover:bg-slate-50">
      <td className="px-4 py-3">
        <div className="mb-1 flex flex-wrap items-center gap-1.5">
          {post.tag.length > 0 && (
            <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[11px] font-semibold text-blue-700">
              {post.tag}
            </span>
          )}
          <StatusBadge
            status={post.status}
            onClick={post.status === 'proven' ? () => onOpenProof(post.messageHash) : undefined}
          />
        </div>
        <Link
          href={`/thread/${post.messageHash}`}
          className="font-semibold text-slate-900 hover:text-blue-600"
        >
          {post.title}
        </Link>
        <div className="mt-0.5 flex items-center gap-1 text-xs text-slate-400">
          <AddressDisplay address={post.sender} ensName={post.senderEns} />
          <span>·</span>
          <span>{relativeTime(post.timestamp)}</span>
          {likeCount > 0 && (
            <>
              <span>·</span>
              <span>♥ {likeCount}</span>
            </>
          )}
        </div>
      </td>
      <td className="w-20 px-4 py-3 text-center">
        <span className="text-sm font-medium text-slate-600">{replyCount}</span>
      </td>
      <td className="w-28 px-4 py-3 text-right text-xs text-slate-400">
        {relativeTime(post.timestamp)}
      </td>
    </tr>
  );
}
