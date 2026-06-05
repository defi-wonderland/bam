'use client';

import Link from 'next/link';
import { ConnectButton } from '@rainbow-me/rainbowkit';

const THREAD = {
  tag: 'Protocol',
  author: '0xdead…beef',
  age: '2 hours ago',
  title: 'How does BAM handle message ordering across blobs?',
  body: `Each sender maintains a monotonically increasing nonce. The Reader reconstructs order from (sender, nonce) pairs, so batches can land out of order without losing thread coherence.\n\nDoes this mean two senders can interleave freely as long as their own nonces are in order? Or is there a global sequence enforced by the Poster?`,
};

const REPLIES = [
  {
    author: '0xc0ff…ee42',
    age: '1 hour ago',
    body: 'Yes — ordering is per-sender only. The Poster enforces nonce monotonicity per sender before accepting a message into the pending queue, but it makes no promise about interleaving between different senders. The Reader sorts by block number first, then (sender, nonce) as a tiebreaker.',
  },
  {
    author: '0xdead…beef',
    age: '45 minutes ago',
    body: 'That makes sense. So a reply that references a parent by messageHash is always stable even if the batch lands before the parent\'s batch is finalised?',
  },
  {
    author: '0xface…1234',
    age: '30 minutes ago',
    body: 'Exactly — messageHash is keccak256(sender ‖ nonce ‖ contents), computable before the batch hits the chain. The Reader parks orphan replies until the parent confirms.',
  },
];

export default function ThreadPage() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <header className="flex items-baseline justify-between pb-4 mb-6 border-b border-slate-200 dark:border-slate-700">
        <span className="font-bold text-lg">BAM Forum</span>
        <ConnectButton />
      </header>

      <div className="text-sm text-slate-500 mb-4">
        <Link href="/" className="text-blue-600 dark:text-blue-400 hover:underline">
          General Discussion
        </Link>
        <span className="mx-2">›</span>
        <span>Thread</span>
      </div>

      <div className="pb-6 mb-6 border-b border-slate-200 dark:border-slate-700">
        <div className="flex items-center gap-2 text-xs text-slate-500 mb-2">
          <span className="bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300 font-semibold px-2 py-0.5 rounded-full">
            {THREAD.tag}
          </span>
          <span>·</span>
          <span>{THREAD.author}</span>
          <span>·</span>
          <span>{THREAD.age}</span>
        </div>
        <h1 className="text-xl font-bold mb-4">{THREAD.title}</h1>
        {THREAD.body.split('\n\n').map((p, i) => (
          <p key={i} className="text-slate-700 dark:text-slate-300 mb-3 last:mb-0">
            {p}
          </p>
        ))}
      </div>

      <ol className="space-y-5">
        {REPLIES.map((r, i) => (
          <li key={i} className="border-l-2 border-slate-200 dark:border-slate-700 pl-4">
            <div className="flex items-center gap-2 text-xs text-slate-500 mb-2">
              <span className="font-medium">{r.author}</span>
              <span>·</span>
              <span>{r.age}</span>
            </div>
            <p className="text-sm text-slate-700 dark:text-slate-300">{r.body}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
