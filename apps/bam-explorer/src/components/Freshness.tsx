'use client';

import { memo, useEffect, useState } from 'react';

function formatAge(seconds: number): string {
  if (seconds < 1) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  if (minutes < 60) return rem === 0 ? `${minutes}m ago` : `${minutes}m ${rem}s ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

// Initial render shows "just now" so SSR/CSR match without a
// hydration mismatch (the server's `fetchedAt = Date.now()` is by
// definition zero seconds old at render time).
export const Freshness = memo(function Freshness({ fetchedAt }: { fetchedAt: number }) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const seconds = now === null ? 0 : Math.max(0, Math.floor((now - fetchedAt) / 1000));
  const label = formatAge(seconds);

  return (
    <span
      role="status"
      aria-label={`data fetched ${label}`}
      className="text-xs text-slate-500"
      data-testid="freshness"
      data-fetched-at={fetchedAt}
    >
      fetched {label}
    </span>
  );
});
