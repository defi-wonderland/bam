'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';

export function IslandScene() {
  return (
    <div className="relative bg-gradient-to-b from-sky-300 via-sky-200 to-ocean-200 pt-8 pb-20 text-center overflow-hidden">
      {/* Sun */}
      <div className="absolute top-6 right-12 w-20 h-20 bg-yellow-300 rounded-full shadow-lg shadow-yellow-200/50 opacity-90" />

      {/* Clouds */}
      <div className="absolute top-12 left-16 w-24 h-8 bg-white/60 rounded-full blur-sm" />
      <div className="absolute top-8 left-28 w-16 h-6 bg-white/40 rounded-full blur-sm" />

      {/* Island */}
      <div className="relative mx-auto w-64 mt-16">
        {/* Palm tree — bottom-aligned so trunk sits on the sand */}
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2">
          <div className="text-7xl select-none leading-none">🌴</div>
        </div>
        {/* Sand mound */}
        <div className="h-12 bg-sand-300 rounded-[50%] shadow-inner" />
      </div>

      {/* Ocean waves */}
      <div className="absolute bottom-0 left-0 right-0">
        <svg viewBox="0 0 1440 60" className="w-full text-ocean-200 fill-current">
          <path d="M0,30 C240,60 480,0 720,30 C960,60 1200,0 1440,30 L1440,60 L0,60 Z" />
        </svg>
      </div>

      <h1 className="text-4xl font-bold text-ocean-800 mt-8 mb-2 font-island">
        Message in a Blobble
      </h1>
      <p className="text-ocean-600 mb-6 text-lg">
        Cast your message into Sepolia blobspace via EIP-4844 blobs
      </p>

      <div className="flex justify-center">
        <ConnectButton />
      </div>
    </div>
  );
}
