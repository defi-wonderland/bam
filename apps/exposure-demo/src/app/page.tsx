import { Header } from '@/components/Header';
import { BLSKeyManager } from '@/components/BLSKeyManager';
import { MessageComposer } from '@/components/MessageComposer';
import { PostBlobButton } from '@/components/PostBlobButton';
import { BlobBrowser } from '@/components/BlobBrowser';
import { ExposureHistory } from '@/components/ExposureHistory';

export default function Home() {
  return (
    <main className="min-h-screen">
      <Header />
      <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
        <div className="rounded-xl border border-indigo-800/30 bg-indigo-900/10 p-4 text-sm text-slate-300">
          <p className="font-medium text-indigo-300 mb-1">How this demo works</p>
          <ol className="list-decimal list-inside space-y-1 text-slate-400">
            <li>Register a BLS12-381 key on-chain (one-time setup)</li>
            <li>Compose a message and sign it with your BLS key</li>
            <li>Post the message in an EIP-4844 blob (registered via SocialBlobsCore)</li>
            <li>Browse registered blobs, decode messages, and expose them on-chain</li>
            <li>Exposure verifies KZG proofs + BLS signature via BLSExposer contract</li>
          </ol>
        </div>

        <BLSKeyManager />
        <MessageComposer />
        <PostBlobButton />
        <BlobBrowser />
        <ExposureHistory />
      </div>
    </main>
  );
}
