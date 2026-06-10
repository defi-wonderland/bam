/**
 * Pure thread-construction helpers. Posts are roots keyed by
 * `messageHash`; replies attach by `parentMessageHash`; likes count
 * per `targetMessageHash`, deduped per sender (a wallet can only
 * meaningfully like a post once — duplicates from poster/reader race
 * collapse).
 */

import type {
  ForumMessage,
  LikeRow,
  PostRow,
  ReplyRow,
} from './forum-row';

export interface Thread {
  post: PostRow;
  /** Replies sorted by `timestamp` ascending; orphan replies excluded. */
  replies: ReplyRow[];
  /** Distinct sender count of likes targeting this post. */
  likeCount: number;
  /** True when `viewer` (lowercased) has already liked this post. */
  alreadyLikedBy(viewer: string | null | undefined): boolean;
  /** Lowercased sender set of likers for downstream queries. */
  likers: ReadonlySet<string>;
}

/**
 * Group a flat row list into one `Thread` per `PostRow`, in the
 * caller's order (we don't sort here — pages handle freshness sort).
 */
export function buildThreads(rows: ForumMessage[]): Thread[] {
  const posts: PostRow[] = [];
  const repliesByParent = new Map<string, ReplyRow[]>();
  const likesByTarget = new Map<string, Set<string>>(); // target -> set of lowercased senders

  for (const row of rows) {
    switch (row.kind) {
      case 'post':
        posts.push(row);
        break;
      case 'reply': {
        const key = row.parentMessageHash.toLowerCase();
        let bucket = repliesByParent.get(key);
        if (!bucket) {
          bucket = [];
          repliesByParent.set(key, bucket);
        }
        bucket.push(row);
        break;
      }
      case 'like': {
        const key = row.targetMessageHash.toLowerCase();
        let likers = likesByTarget.get(key);
        if (!likers) {
          likers = new Set();
          likesByTarget.set(key, likers);
        }
        likers.add(row.sender.toLowerCase());
        break;
      }
    }
  }

  return posts.map((post) => buildThread(post, repliesByParent, likesByTarget));
}

/** Get one thread by post hash; returns `null` when not in the row set. */
export function getThread(
  rows: ForumMessage[],
  postMessageHash: string
): Thread | null {
  const target = postMessageHash.toLowerCase();
  for (const row of rows) {
    if (row.kind === 'post' && row.messageHash.toLowerCase() === target) {
      return buildSingleThread(row, rows);
    }
  }
  return null;
}

function buildSingleThread(post: PostRow, rows: ForumMessage[]): Thread {
  const repliesByParent = new Map<string, ReplyRow[]>();
  const likesByTarget = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.kind === 'reply') {
      const key = row.parentMessageHash.toLowerCase();
      let bucket = repliesByParent.get(key);
      if (!bucket) {
        bucket = [];
        repliesByParent.set(key, bucket);
      }
      bucket.push(row);
    } else if (row.kind === 'like') {
      const key = row.targetMessageHash.toLowerCase();
      let likers = likesByTarget.get(key);
      if (!likers) {
        likers = new Set();
        likesByTarget.set(key, likers);
      }
      likers.add(row.sender.toLowerCase());
    }
  }
  return buildThread(post, repliesByParent, likesByTarget);
}

function buildThread(
  post: PostRow,
  repliesByParent: Map<string, ReplyRow[]>,
  likesByTarget: Map<string, Set<string>>
): Thread {
  const key = post.messageHash.toLowerCase();
  const replies = (repliesByParent.get(key) ?? []).slice().sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    return a.messageHash.localeCompare(b.messageHash);
  });
  const likers = likesByTarget.get(key) ?? new Set<string>();
  return {
    post,
    replies,
    likeCount: likers.size,
    likers,
    alreadyLikedBy(viewer) {
      if (!viewer) return false;
      return likers.has(viewer.toLowerCase());
    },
  };
}

/**
 * Map from `targetMessageHash` (lowercased) → set of lowercased
 * sender addresses that have liked it. Used by `LikeButton` to gate
 * the connected wallet's button when the user has already pending- or
 * confirmed-liked a target.
 */
export function indexLikesBySender(
  rows: ForumMessage[]
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.kind !== 'like') continue;
    const key = row.targetMessageHash.toLowerCase();
    let bucket = out.get(key);
    if (!bucket) {
      bucket = new Set();
      out.set(key, bucket);
    }
    bucket.add(row.sender.toLowerCase());
  }
  return out;
}

/** Find the most recent post for use as a default fallback on `/`. */
export function isLikeRow(row: ForumMessage): row is LikeRow {
  return row.kind === 'like';
}
