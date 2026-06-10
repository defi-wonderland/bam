'use client';

import type { PostRow } from '@/lib/forum-row';
import { relativeTime } from '@/lib/time';

import { AddressDisplay } from './AddressDisplay';
import { LikeButton } from './LikeButton';
import { StatusBadge } from './StatusBadge';

interface ThreadHeaderProps {
  post: PostRow;
  likeCount: number;
  alreadyLikedByMe: boolean;
  onOpenProof: (messageHash: string) => void;
}

export function ThreadHeader({ post, likeCount, alreadyLikedByMe, onOpenProof }: ThreadHeaderProps) {
  return (
    <article className="mb-3 overflow-hidden rounded-md border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50 px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
          {post.tag.length > 0 && (
            <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[11px] font-semibold text-blue-700">
              {post.tag}
            </span>
          )}
          <AddressDisplay address={post.sender} ensName={post.senderEns} />
          <span>·</span>
          <span>{relativeTime(post.timestamp)}</span>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge
            status={post.status}
            onClick={post.status === 'proven' ? () => onOpenProof(post.messageHash) : undefined}
          />
          <LikeButton
            targetMessageHash={post.messageHash}
            likeCount={likeCount}
            alreadyLikedByMe={alreadyLikedByMe}
          />
        </div>
      </div>
      <div className="px-4 py-5">
        <h1 className="mb-3 text-xl font-bold text-slate-900">{post.title}</h1>
        {post.body.split('\n\n').map((paragraph, i) => (
          <p key={i} className="mt-2 whitespace-pre-wrap text-slate-700">
            {paragraph}
          </p>
        ))}
      </div>
    </article>
  );
}
