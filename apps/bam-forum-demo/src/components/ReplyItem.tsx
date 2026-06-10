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

export function ReplyItem({ reply, likeCount, alreadyLikedByMe, onOpenProof }: ReplyItemProps) {
  return (
    <li className="overflow-hidden rounded-md border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50 px-4 py-2.5">
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <AddressDisplay address={reply.sender} ensName={reply.senderEns} className="font-medium" />
          <span>·</span>
          <span>{relativeTime(reply.timestamp)}</span>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge
            status={reply.status}
            onClick={reply.status === 'proven' ? () => onOpenProof(reply.messageHash) : undefined}
          />
          <LikeButton
            targetMessageHash={reply.messageHash}
            likeCount={likeCount}
            alreadyLikedByMe={alreadyLikedByMe}
          />
        </div>
      </div>
      <div className="px-4 py-3 text-sm text-slate-700 whitespace-pre-wrap">
        {reply.body}
      </div>
    </li>
  );
}
