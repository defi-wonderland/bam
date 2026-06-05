'use client';

import { useConfirmed } from '@/lib/queries';
import { relativeFromIso } from '@/lib/time';

export function ProofPanel() {
  const { data } = useConfirmed();
  const counts = data?.proofCounts;

  if (!counts) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
        ⛓ Coprocessor: loading…
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
      <span className="font-mono">⛓ Coprocessor</span>
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
