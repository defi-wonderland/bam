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

export function ThreadHeader({
  post,
  likeCount,
  alreadyLikedByMe,
  onOpenProof,
}: ThreadHeaderProps) {
  return (
    <div className="pb-6 mb-6 border-b border-slate-200 dark:border-slate-700">
      <div className="mb-2 flex items-center gap-2 text-xs text-slate-500">
        {post.tag.length > 0 && (
          <span className="rounded-full bg-blue-50 px-2 py-0.5 font-semibold text-blue-700 dark:bg-blue-950 dark:text-blue-300">
            {post.tag}
          </span>
        )}
        <AddressDisplay address={post.sender} ensName={post.senderEns} />
        <span>·</span>
        <span>{relativeTime(post.timestamp)}</span>
        <span className="ml-auto flex items-center gap-2">
          <StatusBadge
            status={post.status}
            onClick={
              post.status === 'proven'
                ? () => onOpenProof(post.messageHash)
                : undefined
            }
          />
          <LikeButton
            targetMessageHash={post.messageHash}
            likeCount={likeCount}
            alreadyLikedByMe={alreadyLikedByMe}
          />
        </span>
      </div>
      <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">
        {post.title}
      </h1>
      {post.body.split('\n\n').map((paragraph, i) => (
        <p
          key={i}
          className="mt-3 whitespace-pre-wrap text-slate-700 dark:text-slate-300"
        >
          {paragraph}
        </p>
      ))}
    </div>
  );
}
