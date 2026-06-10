/**
 * Compact relative-time formatter. Returns strings like
 * "just now", "12s ago", "4m ago", "3h ago", "2d ago".
 */
export function relativeTime(unixSeconds: number, nowMs: number = Date.now()): string {
  const deltaSec = Math.max(0, Math.floor(nowMs / 1000) - unixSeconds);
  if (deltaSec < 10) return 'just now';
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const m = Math.floor(deltaSec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function relativeFromIso(iso: string | null, nowMs: number = Date.now()): string {
  if (iso === null) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  return relativeTime(Math.floor(t / 1000), nowMs);
}
