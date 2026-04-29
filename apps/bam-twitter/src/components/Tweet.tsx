'use client';

import { useState } from 'react';
import type { Bytes32 } from 'bam-sdk/browser';

import { AddressLink } from '@/components/AddressLink';
import { Composer } from '@/components/Composer';
import type { DisplayTweet } from '@/lib/timeline';

interface TweetProps {
  tweet: DisplayTweet;
  /** Direct replies to render under this tweet. */
  replies?: DisplayTweet[];
}

export function Tweet({ tweet, replies = [] }: TweetProps) {
  const [showReply, setShowReply] = useState(false);
  const time = new Date(tweet.timestamp * 1000).toLocaleString();

  // v1 caps reply depth at one level: top-level posts are repliable,
  // replies are not. The Timeline only renders direct replies under
  // top-level posts, so allowing replies-to-replies would silently
  // accept tweets that never get displayed. Lifting this cap means
  // also rendering the reply tree recursively (with depth limits +
  // indentation) — out of scope for v1.
  const isReplyable = tweet.parentMessageHash === null;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 hover:bg-slate-50 transition-colors">
      <div className="flex items-center justify-between mb-1">
        <AddressLink address={tweet.sender} className="text-sm" />
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">{time}</span>
          <span
            className={`text-xs px-2 py-0.5 rounded-full ${
              tweet.status === 'pending'
                ? 'bg-amber-100 text-amber-700'
                : 'bg-emerald-100 text-emerald-700'
            }`}
          >
            {tweet.status === 'pending' ? 'pending' : 'on-chain'}
          </span>
        </div>
      </div>
      <p className="text-slate-900 whitespace-pre-wrap break-words">{tweet.content}</p>

      <div className="mt-3 flex items-center gap-3 text-xs text-slate-500">
        {isReplyable && (
          <button
            type="button"
            onClick={() => setShowReply((v) => !v)}
            className="hover:text-bird-600 focus:outline-none focus:ring-2 focus:ring-bird-300 rounded px-1"
          >
            {showReply ? 'Cancel' : 'Reply'}
          </button>
        )}
        {tweet.tx_hash && (
          <a
            href={`https://sepolia.etherscan.io/tx/${tweet.tx_hash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-slate-400 hover:text-bird-600"
          >
            {tweet.tx_hash.slice(0, 10)}…{tweet.tx_hash.slice(-6)}
          </a>
        )}
        {tweet.block_number != null && (
          <span className="text-slate-400">block {tweet.block_number}</span>
        )}
      </div>

      {showReply && (
        <div className="mt-3 ml-4 border-l-2 border-bird-200 pl-3">
          <Composer
            replyTo={tweet.id as Bytes32}
            onSent={() => setShowReply(false)}
            placeholder={`Reply to ${tweet.sender.slice(0, 6)}…`}
            autoFocus
          />
        </div>
      )}

      {replies.length > 0 && (
        <div className="mt-3 ml-4 border-l-2 border-slate-200 pl-3 space-y-3">
          {replies.map((r) => (
            <Tweet key={r.id} tweet={r} />
          ))}
        </div>
      )}
    </div>
  );
}
