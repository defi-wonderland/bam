import { Freshness } from '../components/Freshness';
import { PosterHealthPanel } from '../components/PosterHealthPanel';
import { PosterPendingPanel } from '../components/PosterPendingPanel';
import { PosterStatusPanel } from '../components/PosterStatusPanel';
import { PosterSubmittedBatchesPanel } from '../components/PosterSubmittedBatchesPanel';
import { ReaderBatchesPanel } from '../components/ReaderBatchesPanel';
import { ReaderHealthPanel } from '../components/ReaderHealthPanel';
import { ReaderMessagesPanel } from '../components/ReaderMessagesPanel';
import { assembleDashboardData } from '../lib/dashboard-data';

// Snapshot is computed server-side per request. Static caching would
// freeze the freshness indicator at build time and defeat the point
// of the page.
export const dynamic = 'force-dynamic';

export default async function Page() {
  const data = await assembleDashboardData();

  return (
    <main className="max-w-6xl mx-auto px-6 py-8">
      <header className="flex items-baseline justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">BAM Explorer</h1>
          <p className="text-sm text-slate-600">
            Read-only snapshot of a Reader + Poster pair.
          </p>
        </div>
        <div className="flex items-baseline gap-3">
          <Freshness fetchedAt={data.fetchedAt} />
          <a
            href="/"
            className="text-sm font-medium text-slate-700 hover:text-slate-900 underline"
          >
            Reload
          </a>
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <PosterHealthPanel result={data.posterHealth} />
        <ReaderHealthPanel result={data.readerHealth} />
        <PosterStatusPanel result={data.posterStatus} />
        <PosterPendingPanel result={data.posterPending} />
        <PosterSubmittedBatchesPanel result={data.posterSubmittedBatches} />
      </div>

      <div className="grid grid-cols-1 gap-4 mt-4">
        <ReaderBatchesPanel
          resultsByTag={data.readerBatchesByTag}
          noTagsConfigured={data.noTagsConfigured}
        />
        <ReaderMessagesPanel
          resultsByTag={data.readerMessagesByTag}
          noTagsConfigured={data.noTagsConfigured}
        />
      </div>
    </main>
  );
}
