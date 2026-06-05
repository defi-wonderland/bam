'use client';

import Link from 'next/link';
import { ConnectButton } from '@rainbow-me/rainbowkit';

const THREADS = [
  {
    id: '1',
    tag: 'Protocol',
    author: '0xdead…beef',
    age: '2 hours ago',
    title: 'How does BAM handle message ordering across blobs?',
    preview:
      'Each sender maintains a monotonically increasing nonce. The Reader reconstructs order from (sender, nonce) pairs, so batches can land out of order…',
    replies: 12,
  },
  {
    id: '2',
    tag: 'Dev',
    author: '0xc0ff…ee42',
    age: '5 hours ago',
    title: 'Running the full stack locally — a step-by-step guide',
    preview:
      'Start with pnpm install at the workspace root, then pnpm db:up to spin up Postgres. The Poster and Reader share the same database…',
    replies: 7,
  },
  {
    id: '3',
    tag: 'General',
    author: '0xface…1234',
    age: '1 day ago',
    title: 'ERC-8180 vs. other on-chain messaging standards',
    preview:
      'The key difference is that ERC-8180 uses blob data for content storage, keeping calldata costs near zero while still anchoring authenticity on-chain…',
    replies: 24,
  },
];

export default function Home() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <header className="flex items-baseline justify-between pb-4 mb-6 border-b border-slate-200 dark:border-slate-700">
        <span className="font-bold text-lg">BAM Forum</span>
        <ConnectButton />
      </header>

      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1">General Discussion</h1>
        <p className="text-sm text-slate-500">Decentralised threads, backed by blobs.</p>
      </div>

      <ul className="divide-y divide-slate-200 dark:divide-slate-700">
        {THREADS.map((t) => (
          <li key={t.id} className="py-5">
            <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
              <span className="bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300 font-semibold px-2 py-0.5 rounded-full">
                {t.tag}
              </span>
              <span>·</span>
              <span>{t.author}</span>
              <span>·</span>
              <span>{t.age}</span>
            </div>
            <Link
              href={`/thread/${t.id}`}
              className="block font-semibold text-slate-900 dark:text-slate-100 hover:text-blue-600 dark:hover:text-blue-400 mb-1"
            >
              {t.title}
            </Link>
            <p className="text-sm text-slate-500 line-clamp-2 mb-2">{t.preview}</p>
            <span className="text-xs text-slate-400">💬 {t.replies} replies</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
