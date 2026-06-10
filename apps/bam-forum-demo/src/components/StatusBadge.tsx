'use client';

import type { BadgeState } from '@/lib/forum-row';

interface StatusBadgeProps {
  status: BadgeState;
  onClick?: () => void;
}

const META: Record<
  BadgeState,
  { label: string; tooltip: string; classes: string }
> = {
  pending: {
    label: 'Pending',
    tooltip: 'In the poster queue, not yet in a blob batch',
    classes: 'bg-amber-100 text-amber-800 border-amber-200',
  },
  confirmed: {
    label: 'Confirmed',
    tooltip: 'Included in a Sepolia blob — locally verifiable',
    classes: 'bg-blue-100 text-blue-800 border-blue-200',
  },
  validated: {
    label: 'Validated',
    tooltip: 'Coprocessor C1 execute reproduced the messageHash from the blob',
    classes: 'bg-teal-100 text-teal-800 border-teal-200',
  },
  proven: {
    label: 'Proven',
    tooltip: 'Click for the Groth16 proof bundle',
    classes:
      'bg-emerald-100 text-emerald-800 border-emerald-300 cursor-pointer hover:bg-emerald-200',
  },
};

export function StatusBadge({ status, onClick }: StatusBadgeProps) {
  const m = META[status];
  const interactive = status === 'proven' && onClick !== undefined;
  return (
    <button
      type="button"
      onClick={interactive ? onClick : undefined}
      disabled={!interactive}
      title={m.tooltip}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${m.classes} ${
        interactive ? '' : 'cursor-default'
      }`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {m.label}
    </button>
  );
}
