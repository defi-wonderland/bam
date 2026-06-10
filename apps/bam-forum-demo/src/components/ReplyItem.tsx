'use client';

import type { ReplyRow } from '@/lib/forum-row';
import { relativeTime } from '@/lib/time';

import { AddressDisplay } from './AddressDisplay';
import { LikeButton } from './LikeButton';
import { StatusBadge } from './StatusBadge';

interface ReplyItemProps {
  reply: ReplyRow;
  likeCount: number;
  alreadyLikedByMe: boolean;
  onOpenProof: (messageHash: string) => void;
}

export function ReplyItem({
  reply,
  likeCount,
  alreadyLikedByMe,
  onOpenProof,
}: ReplyItemProps) {
  return (
    <li className="border-l-2 border-slate-200 pl-4 dark:border-slate-700">
      <div className="mb-2 flex items-center gap-2 text-xs text-slate-500">
        <AddressDisplay
          address={reply.sender}
          ensName={reply.senderEns}
          className="font-medium"
        />
        <span>·</span>
        <span>{relativeTime(reply.timestamp)}</span>
        <span className="ml-auto flex items-center gap-2">
          <StatusBadge
            status={reply.status}
            onClick={
              reply.status === 'proven'
                ? () => onOpenProof(reply.messageHash)
                : undefined
            }
          />
          <LikeButton
            targetMessageHash={reply.messageHash}
            likeCount={likeCount}
            alreadyLikedByMe={alreadyLikedByMe}
          />
        </span>
      </div>
      <p className="whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-300">
        {reply.body}
      </p>
    </li>
  );
}
