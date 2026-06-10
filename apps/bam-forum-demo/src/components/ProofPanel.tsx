'use client';

import { useConfirmed } from '@/lib/queries';
import { relativeFromIso } from '@/lib/time';

export function ProofPanel() {
  const { data } = useConfirmed();
  const counts = data?.proofCounts;

  if (!counts) return null;

  return (
    <div className="mb-4 flex items-center gap-3 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500">
      <span className="font-medium text-slate-600">⛓ Coprocessor</span>
      <span>
        <span className="font-semibold text-teal-700">{counts.validated}</span> validated
      </span>
      <span>·</span>
      <span>
        <span className="font-semibold text-emerald-700">{counts.proven}</span> proven
      </span>
      <span>·</span>
      <span>latest {relativeFromIso(counts.latestProvenAt)}</span>
    </div>
  );
}
