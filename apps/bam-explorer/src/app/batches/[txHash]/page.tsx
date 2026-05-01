import Link from 'next/link';

import { BatchDetailCard, type BatchDetailState } from '../../../components/BatchDetailCard';
import { Freshness } from '../../../components/Freshness';
import { fetchReaderBatchByTxHash } from '../../../lib/fetchers';
import { isHex32 } from '../../../lib/panel-helpers';

export const dynamic = 'force-dynamic';

export default async function BatchDetailPage({
  params,
}: {
  params: Promise<{ txHash: string }>;
}) {
  const { txHash } = await params;
  const fetchedAt = Date.now();

  let state: BatchDetailState;
  if (!isHex32(txHash)) {
    state = { kind: 'malformed', fetchedAt };
  } else {
    state = (await fetchReaderBatchByTxHash(txHash)) as BatchDetailState;
  }

  return (
    <main className="max-w-4xl mx-auto px-6 py-8">
      <header className="flex items-baseline justify-between mb-6">
        <div>
          <Link href="/" className="text-xs text-slate-500 hover:underline">
            ← back to dashboard
          </Link>
          <h1 className="text-2xl font-semibold mt-1">Batch detail</h1>
          <p className="font-mono text-xs text-slate-600 mt-1">{txHash}</p>
        </div>
        <Freshness fetchedAt={fetchedAt} />
      </header>

      <BatchDetailCard txHash={txHash} state={state} />
    </main>
  );
}
