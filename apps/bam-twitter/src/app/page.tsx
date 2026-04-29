'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';

import { Composer } from '@/components/Composer';
import { Timeline } from '@/components/Timeline';

export default function Home() {
  return (
    <main className="min-h-screen">
      <header className="sticky top-0 z-10 backdrop-blur bg-white/80 border-b border-slate-200">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <h1 className="text-lg font-bold text-bird-700">BAM Twitter</h1>
          <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false} />
        </div>
      </header>
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-6">
        <Composer />
        <Timeline />
      </div>
    </main>
  );
}
