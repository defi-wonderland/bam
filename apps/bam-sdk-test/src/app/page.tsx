'use client';

import { PROTOCOL_VERSION_STRING } from 'bam-sdk/browser';
import { HexSection } from '@/components/HexSection';
import { MessageSection } from '@/components/MessageSection';
import { EcdsaSection } from '@/components/EcdsaSection';
import { BlsSection } from '@/components/BlsSection';
import { BatchSection } from '@/components/BatchSection';
import { ExposureSection } from '@/components/ExposureSection';
import { BpeSection } from '@/components/BpeSection';
import { CompressionSection } from '@/components/CompressionSection';

const NAV: Array<{ id: string; label: string }> = [
  { id: 'hex', label: 'Hex' },
  { id: 'message', label: 'Message' },
  { id: 'ecdsa', label: 'ECDSA' },
  { id: 'bls', label: 'BLS' },
  { id: 'batch', label: 'Batch' },
  { id: 'exposure', label: 'Exposure' },
  { id: 'bpe', label: 'BPE' },
  { id: 'compression', label: 'Compression' },
];

export default function Home() {
  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">bam-sdk test app</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
          Surfaces every browser-safe export of the <code>bam-sdk</code> package as a
          poke-the-button playground. Demo data is prefilled so each function is one click
          from a result.
        </p>
        <p className="text-xs text-neutral-500 dark:text-neutral-500 mt-1">
          Protocol version {PROTOCOL_VERSION_STRING} · entrypoint <code>bam-sdk/browser</code>
        </p>
        <nav className="mt-3 flex flex-wrap gap-2 text-sm">
          {NAV.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              className="px-2 py-1 rounded border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              {item.label}
            </a>
          ))}
        </nav>
      </header>

      <HexSection />
      <MessageSection />
      <EcdsaSection />
      <BlsSection />
      <BatchSection />
      <ExposureSection />
      <BpeSection />
      <CompressionSection />

      <footer className="mt-8 text-xs text-neutral-500 dark:text-neutral-400">
        Wallet flows (<code>signECDSA</code>) and KZG proofs (<code>kzg/</code>,{' '}
        <code>parseBlobForMessages</code>, <code>buildExposureParams</code>) are excluded from
        the browser entrypoint and not surfaced here. Run those from the Node-side bundles or
        the existing <code>message-in-a-blobble</code> app.
      </footer>
    </main>
  );
}
