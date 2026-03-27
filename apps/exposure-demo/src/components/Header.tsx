'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';

export function Header() {
  return (
    <header className="border-b border-slate-800 bg-slate-950/80 backdrop-blur-sm sticky top-0 z-50">
      <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">BAM Exposure Demo</h1>
          <p className="text-xs text-slate-400 mt-0.5">
            On-chain message exposure via EIP-4844 blobs
          </p>
        </div>
        <ConnectButton showBalance={false} />
      </div>
    </header>
  );
}
