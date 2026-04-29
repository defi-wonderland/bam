'use client';

import { useQuery } from '@tanstack/react-query';

import { Tweet } from '@/components/Tweet';
import {
  fetchTweets,
  TWEETS_QUERY_KEY,
  TWEETS_REFETCH_MS,
  type DisplayTweet,
} from '@/lib/timeline';

/**
 * Renders the merged pending + confirmed feed grouped by thread.
 *
 * Top-level posts (no `parentMessageHash`) are listed in reverse
 * chronological order; direct replies are rendered under each post.
 * Orphan replies — those whose parent isn't in the current view —
 * are hidden until the parent shows up; lazily fetching them isn't
 * worth the complexity for v1.
 */
export function Timeline() {
  const { data: tweets = [], isLoading } = useQuery({
    queryKey: TWEETS_QUERY_KEY,
    queryFn: fetchTweets,
    refetchInterval: TWEETS_REFETCH_MS,
  });

  if (isLoading) {
    return (
      <div className="text-center text-slate-400 py-8">Loading feed…</div>
    );
  }
  if (tweets.length === 0) {
    return (
      <div className="text-center text-slate-400 py-8">
        No posts yet. Be the first.
      </div>
    );
  }

  const repliesByParent = new Map<string, DisplayTweet[]>();
  for (const t of tweets) {
    if (t.parentMessageHash !== null) {
      const list = repliesByParent.get(t.parentMessageHash) ?? [];
      list.push(t);
      repliesByParent.set(t.parentMessageHash, list);
    }
  }
  for (const list of repliesByParent.values()) {
    list.sort((a, b) => a.timestamp - b.timestamp);
  }

  const topLevel = tweets.filter((t) => t.parentMessageHash === null);

  return (
    <div className="space-y-4">
      {topLevel.map((t) => (
        <Tweet key={t.id} tweet={t} replies={repliesByParent.get(t.id) ?? []} />
      ))}
    </div>
  );
}
